import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { enviarMensagemWhatsApp, getRecrutamentoEvolutionConfigPorResponsavel } from '@/lib/evolution-api';
import { criarTokenReferencias } from '@/lib/referencias-token';
import { gerarEEnviarContratoDiaTeste } from '@/lib/recrutamento-dia-teste';
import {
  loadAgendamento,
  avancarProcessoAposDecisao,
  calcularPodeDecidir,
  calcularValorTotalProcesso,
  contarAgendamentosPendentesDoProcesso,
  criarProximoDiaTeste,
  invalidarCacheAgendamentosDiaTeste,
  verificarEscopoGestorAgendamento,
} from '../_helpers';
import { forbiddenResponse } from '@/lib/api-response';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/aprovar
//
// Aprova o candidato no agendamento. 3 ações disponíveis:
//
//  - 'encerrar' (default): processo segue pra pré-admissão. Cancela
//    quaisquer dias futuros do processo e cria provisório+solicitação.
//  - 'manter':  marca agendamento atual como 'aprovado' SEM avançar
//    processo. Só permitido se há outro agendamento pendente
//    ('agendado'/'compareceu') no mesmo processo.
//  - 'adicionar_dia': marca agendamento atual como 'aprovado' e cria
//    um NOVO agendamento (ordem+1) no processo com a data informada.
//    Só permitido quando NÃO há agendamento pendente além do atual.
//
// Em ambos 'manter' e 'adicionar_dia', o processo continua em 'dia_teste'
// e nenhum provisório/solicitação é criado — a transição pra pré-admissão
// só acontece quando o gestor escolhe 'encerrar' num dos dias.

const schema = z.object({
  observacao: z.string().max(2000).optional(),
  acao: z.enum(['encerrar', 'manter', 'adicionar_dia']).default('encerrar'),
  // Obrigatório quando acao='adicionar_dia'.
  dataNovoDia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dataNovoDia deve estar no formato YYYY-MM-DD')
    .optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const body = await req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }

      const ag = await loadAgendamento(id);
      if (!ag) return notFoundResponse('Agendamento não encontrado');

      const escopoCheck = await verificarEscopoGestorAgendamento(user, ag);
      if (!escopoCheck.ok) {
        return forbiddenResponse(escopoCheck.motivo);
      }

      if (ag.processo_status === 'cancelado') {
        return errorResponse(
          'Processo seletivo está cancelado — nenhuma ação é permitida no agendamento',
          409,
        );
      }

      if (ag.status !== 'compareceu') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — só pode aprovar candidatos que compareceram`,
          409,
        );
      }

      // Defesa em profundidade — bloqueia aprovação antes de 50% da
      // carga horária mesmo se o cliente burlar. Mensagem traz o horário
      // exato em que o gestor poderá decidir, pra exibir na UI.
      const decisao = calcularPodeDecidir(ag);
      if (!decisao.podeDecidir) {
        const apos = decisao.podeDecidirApos
          ? decisao.podeDecidirApos.toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/Sao_Paulo',
            })
          : null;
        return errorResponse(
          apos
            ? `Aprovação só é permitida após o candidato cumprir 50% da carga horária (a partir das ${apos}).`
            : 'Aprovação ainda não é permitida — candidato precisa cumprir pelo menos 50% da carga horária do dia.',
          409,
        );
      }

      // Calcula o valor TOTAL do processo até este agendamento (dias
      // anteriores cumpridos + período atual). Em 'encerrar' paga proporcional
      // aos períodos cumpridos. Em 'manter'/'adicionar_dia' o candidato vai
      // continuar trabalhando o dia inteiro — recebe o dia COMPLETO.
      const total = await calcularValorTotalProcesso(ag);

      // Validações específicas de cada ação ────────────────────────────
      const pendentes = await contarAgendamentosPendentesDoProcesso(
        ag.processo_seletivo_id,
        id,
      );

      // `acao` é mutável: se o gestor pediu 'adicionar_dia' mas já existe
      // um dia futuro agendado no processo, degradamos pra 'manter' — só
      // aprova o atual e preserva o dia já marcado. Evita erro 409 no
      // mobile quando o gestor não percebe que o próximo dia já está
      // agendado (relatado em campo: "aprovei e ele só não foi por causa
      // do dia de amanhã que já estava agendado").
      let acao = parsed.data.acao;
      let adicionarDegradadoParaManter = false;
      if (acao === 'adicionar_dia' && pendentes > 0) {
        acao = 'manter';
        adicionarDegradadoParaManter = true;
      }

      // Defesa contra duplicar data: mesmo que não exista pendente, recusa
      // criar um agendamento novo na mesma data de qualquer outro ag do
      // processo (incluindo já aprovados/reprovados). Caso real: gestor
      // aprovou dia 11 (status aprovado), depois voltou no dia 9 e clicou
      // "aprovar e adicionar mais 1 dia" escolhendo 11 — sistema criou
      // ordem 3 também em 11, duplicando o dia. Agora bloqueia.
      if (acao === 'adicionar_dia' && parsed.data.dataNovoDia) {
        const colisaoRes = await query<{ id: string; ordem: number; status: string }>(
          `SELECT id::text, ordem, status
             FROM people.dia_teste_agendamento
            WHERE processo_seletivo_id = $1::bigint
              AND data = $2::date
              AND id != $3::bigint
            LIMIT 1`,
          [ag.processo_seletivo_id, parsed.data.dataNovoDia, id],
        );
        if (colisaoRes.rows[0]) {
          const colisao = colisaoRes.rows[0];
          return errorResponse(
            `Já existe um agendamento neste processo na data ${parsed.data.dataNovoDia} (ordem ${colisao.ordem}, status ${colisao.status}). Escolha outra data.`,
            409,
          );
        }
      }

      if (acao === 'manter' && pendentes === 0) {
        return errorResponse(
          'Não há outro dia agendado para manter o candidato em teste — use "encerrar" ou "adicionar_dia"',
          409,
        );
      }
      if (acao === 'adicionar_dia' && !parsed.data.dataNovoDia) {
        return errorResponse(
          'Campo "dataNovoDia" é obrigatório quando acao="adicionar_dia"',
          400,
        );
      }

      // Sobrescreve valor/percentual quando aprovação MANTÉM o candidato em
      // teste (manter ou adicionar_dia). Como ele vai cumprir o dia inteiro,
      // recebe o valor cheio do dia independente do horário em que o gestor
      // clicou. Encerrar mantém proporcional (decisão fim de carreira do dia).
      const diariaCheia = parseFloat(ag.valor_diaria);
      const ehManterOuAdicionar = acao === 'manter' || acao === 'adicionar_dia';
      const valorAgendamentoAtualFinal = ehManterOuAdicionar
        ? diariaCheia
        : total.valorAgendamentoAtual;
      const percentualAtualFinal = ehManterOuAdicionar
        ? 100
        : total.percentualAtual;
      const periodosAtualFinal: 0 | 1 | 2 = ehManterOuAdicionar
        ? 2
        : total.periodosAtual;
      const valorTotalFinal = ehManterOuAdicionar
        ? Math.round((total.valorDiasAnteriores + diariaCheia) * 100) / 100
        : total.valorTotal;
      const periodosCumpridosProcessoFinal = ehManterOuAdicionar
        ? total.periodosCumpridosProcesso - total.periodosAtual + 2
        : total.periodosCumpridosProcesso;

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'aprovado',
                decidido_por = $1,
                decidido_em = NOW(),
                valor_a_pagar = $2,
                percentual_concluido = $3,
                observacao_decisao = $4,
                atualizado_em = NOW()
          WHERE id = $5::bigint`,
        [
          user.userId,
          valorAgendamentoAtualFinal,
          percentualAtualFinal,
          parsed.data.observacao ?? null,
          id,
        ],
      );

      // Decide próximo passo do processo conforme ação escolhida ─────────
      let proximoStatus: string | null = null;
      let novoAgendamento: { id: string; ordem: number; data: string } | null = null;
      let contratoNovoDia: {
        ok: boolean;
        documentId: string | null;
        signingLink: string | null;
        signProofErro: string | null;
        whatsappOk: boolean;
        whatsappErro: string | null;
      } | null = null;

      if (acao === 'encerrar') {
        // Comportamento original: cancela futuros e move processo pra pré-admissão.
        proximoStatus = await avancarProcessoAposDecisao(
          ag.processo_seletivo_id,
          'aprovado',
          id,
        );
      } else if (acao === 'adicionar_dia') {
        const novo = await criarProximoDiaTeste({
          processoId: ag.processo_seletivo_id,
          data: parsed.data.dataNovoDia!,
          valorDiaria: ag.valor_diaria,
          cargaHoraria: ag.carga_horaria,
        });
        novoAgendamento = { id: novo.id, ordem: novo.ordem, data: parsed.data.dataNovoDia! };
        proximoStatus = 'dia_teste'; // processo permanece

        // Pagamento do novo dia exige assinatura — gera contrato NOVO
        // pra este agendamento e dispara WhatsApp pro candidato com o
        // link de assinatura. Best-effort: falhas não revertem aprovação,
        // ficam registradas em auditoria pra recuperação manual.
        try {
          contratoNovoDia = await gerarEEnviarContratoDiaTeste({
            processoId: ag.processo_seletivo_id,
            agendamentoId: novo.id,
            data: parsed.data.dataNovoDia!,
            valorDiaria: parseFloat(ag.valor_diaria),
            cargaHoraria: ag.carga_horaria,
            diasQtdContrato: 1,
            setarNoProcesso: true,
          });
          if (!contratoNovoDia.ok) {
            console.warn(
              `[dia-teste/aprovar] gerar contrato novo dia falhou agendamento=${novo.id}: signProof=${contratoNovoDia.signProofErro} whatsapp=${contratoNovoDia.whatsappErro}`,
            );
          }
        } catch (e) {
          console.warn('[dia-teste/aprovar] excecao ao gerar contrato novo dia:', e);
          contratoNovoDia = {
            ok: false, documentId: null, signingLink: null,
            signProofErro: `excecao: ${(e as Error).message}`,
            whatsappOk: false, whatsappErro: null,
          };
        }
      } else {
        // 'manter' — não toca em outros agendamentos nem no processo.
        proximoStatus = 'dia_teste';
      }

      // Invalida cache do GET /agendamentos — ver nao-compareceu/route.ts.
      await invalidarCacheAgendamentosDiaTeste();

      // Aprovação no dia de teste com acao='encerrar' agora NÃO cria
      // provisório/solicitação direto — o processo entra em
      // 'coletar_referencias'. Provisório só é gerado quando RH preenche
      // 2 referências do candidato via POST /referencias.
      //
      // Aqui só dispara WhatsApp pro candidato pedindo as referências
      // (best-effort — falha não bloqueia a aprovação).
      let whatsappReferencias: { enviado: boolean; erro?: string } | null = null;

      if (acao === 'encerrar' && proximoStatus === 'coletar_referencias') {
        try {
          const candRes = await queryRecrutamento<{
            nome: string | null;
            telefone: string | null;
            resposavel: string | null;
          }>(
            `SELECT nome, telefone, resposavel FROM public.candidatos WHERE id = $1 LIMIT 1`,
            [Number(ag.candidato_recrutamento_id)],
          );
          const cand = candRes.rows[0];
          const tel = (cand?.telefone ?? '').replace(/\D/g, '');
          const primeiroNome = (cand?.nome ?? 'Candidato').split(' ')[0];
          const responsavel = cand?.resposavel ?? null;

          if (tel.length >= 10) {
            const token = criarTokenReferencias({
              agendamentoId: id,
              candidatoCpf: ag.candidato_cpf_norm,
              candidatoRecrutamentoId: Number(ag.candidato_recrutamento_id),
            });
            const baseWeb = process.env.PUBLIC_WEB_URL ?? 'https://people.valerisapp.com.br';
            const link = `${baseWeb.replace(/\/$/, '')}/referencias?token=${encodeURIComponent(token)}`;

            const mensagem = [
              `Prezado(a) ${primeiroNome},`,
              ``,
              `Para darmos continuidade ao processo seletivo, solicitamos o envio de 2 referências profissionais (preferencialmente gestor direto, como gerente, supervisor ou coordenador) das suas duas últimas experiências profissionais.`,
              ``,
              `Por gentileza, encaminhar as seguintes informações:`,
              ``,
              `• Nome`,
              `• Cargo`,
              `• Empresa`,
              `• Telefone para contato`,
              ``,
              `Você pode preencher diretamente neste formulário (mais rápido):`,
              link,
              ``,
              `Ou, se preferir, basta responder esta mensagem com os dados.`,
              ``,
              `Quanto mais breve recebermos essas informações, mais ágil será a continuidade do seu processo.`,
              ``,
              `Agradecemos desde já!`,
            ].join('\n');

            // Manda pela instancia do recrutador responsavel pelo candidato
            // (mapa em EVOLUTION_INSTANCES_RECRUTAMENTO). Cai pro default
            // (Robson) quando responsavel nao reconhecido ou env nao setada.
            const r = await enviarMensagemWhatsApp(
              tel,
              mensagem,
              getRecrutamentoEvolutionConfigPorResponsavel(responsavel),
            );
            whatsappReferencias = { enviado: r.ok, erro: r.ok ? undefined : r.erro };
            if (!r.ok) {
              console.warn(`[dia-teste/aprovar] WhatsApp pedindo referências falhou: ${r.erro}`);
            }
          } else {
            whatsappReferencias = { enviado: false, erro: 'telefone do candidato ausente' };
            console.warn('[dia-teste/aprovar] sem telefone pra disparar WhatsApp de referências');
          }
        } catch (e) {
          console.warn('[dia-teste/aprovar] erro ao disparar WhatsApp de referências:', e);
          whatsappReferencias = { enviado: false, erro: `${e}` };
        }
      }

      // Mantido vazio aqui — agora só preenchido pelo /referencias quando
      // RH confirma as referências e a pré-admissão é efetivamente criada.
      const provisorioInfo: {
        provisorioId: number;
        solicitacaoId: string;
        reutilizado: boolean;
        readmissao: boolean;
      } | null = null;

      const descAcao =
        acao === 'encerrar'
          ? 'aguardando RH coletar 2 referências do candidato'
          : acao === 'adicionar_dia'
            ? `mantido em teste — novo dia agendado (${novoAgendamento?.data}, ordem ${novoAgendamento?.ordem})`
            : adicionarDegradadoParaManter
              ? 'mantido em teste — pedido era adicionar dia, mas já havia um dia agendado'
              : 'mantido em teste — aguardando próximo dia já agendado';

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato APROVADO no dia de teste #${id} (a pagar: R$ ${valorTotalFinal.toFixed(2)} = R$ ${total.valorDiasAnteriores.toFixed(2)} dias anteriores + R$ ${valorAgendamentoAtualFinal.toFixed(2)} hoje); ${descAcao}`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            acao,
            periodosCumpridos: periodosAtualFinal,
            percentualConcluido: percentualAtualFinal,
            valorAgendamentoAtual: valorAgendamentoAtualFinal,
            valorDiasAnteriores: total.valorDiasAnteriores,
            valorTotal: valorTotalFinal,
            observacao: parsed.data.observacao ?? null,
            provisorio: provisorioInfo,
            novoAgendamento,
            whatsappReferencias,
            contratoNovoDia,
          },
        }),
      );

      // Formato esperado pelo mobile (DecisaoDiaTesteResponse): chaves
      // valorAPagar e proximoPasso indicam que é uma decisão.
      // valorAPagar = total cumulativo do processo (dias anteriores +
      // período atual). valorAgendamentoAtual = só o agendamento atual.
      const proximoPasso =
        acao === 'encerrar'
          ? proximoStatus === 'coletar_referencias' ? 'coletar_referencias' : 'encerrado'
          : acao === 'adicionar_dia'
            ? 'novo_dia_agendado'
            : 'manter_em_teste';

      return successResponse({
        agendamentoId: id,
        status: 'aprovado',
        acao,
        // Sinaliza pro mobile que a ação solicitada foi degradada
        // (gestor pediu 'adicionar_dia' mas processo já tinha pendente).
        acaoDegradada: adicionarDegradadoParaManter ? 'adicionar_dia->manter' : null,
        valorAPagar: valorTotalFinal,
        valorAgendamentoAtual: valorAgendamentoAtualFinal,
        valorDiasAnteriores: total.valorDiasAnteriores,
        periodosCumpridos: periodosAtualFinal,
        percentualConcluido: percentualAtualFinal,
        periodosCumpridosProcesso: periodosCumpridosProcessoFinal,
        decididoEm: new Date().toISOString(),
        proximoPasso,
        processo: {
          id: ag.processo_seletivo_id,
          status: proximoStatus,
        },
        provisorio: provisorioInfo,
        novoAgendamento,
        whatsappReferencias,
        contratoNovoDia,
      });
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/aprovar] erro:',
        error,
      );
      return serverErrorResponse('Erro ao aprovar candidato');
    }
  });
}
