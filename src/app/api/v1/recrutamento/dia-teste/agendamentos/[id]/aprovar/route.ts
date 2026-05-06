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
import { criarOuReaproveitarProvisorio } from '@/lib/usuarios-provisorios';
import {
  loadAgendamento,
  avancarProcessoAposDecisao,
  calcularPodeDecidir,
  calcularValorTotalProcesso,
  contarAgendamentosPendentesDoProcesso,
  criarProximoDiaTeste,
} from '../_helpers';

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
      // anteriores cumpridos + período atual). Aprovado também paga
      // proporcional aos períodos cumpridos — a regra de "decisão pula
      // dias restantes" só se aplica aos dias FUTUROS, não retroativo.
      const total = await calcularValorTotalProcesso(ag);

      const acao = parsed.data.acao;

      // Validações específicas de cada ação ────────────────────────────
      const pendentes = await contarAgendamentosPendentesDoProcesso(
        ag.processo_seletivo_id,
        id,
      );

      if (acao === 'manter' && pendentes === 0) {
        return errorResponse(
          'Não há outro dia agendado para manter o candidato em teste — use "encerrar" ou "adicionar_dia"',
          409,
        );
      }
      if (acao === 'adicionar_dia') {
        if (pendentes > 0) {
          return errorResponse(
            'Já existe um dia de teste agendado neste processo — use "manter em teste" para o próximo dia ou "encerrar"',
            409,
          );
        }
        if (!parsed.data.dataNovoDia) {
          return errorResponse(
            'Campo "dataNovoDia" é obrigatório quando acao="adicionar_dia"',
            400,
          );
        }
      }

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
          total.valorAgendamentoAtual,
          total.percentualAtual,
          parsed.data.observacao ?? null,
          id,
        ],
      );

      // Decide próximo passo do processo conforme ação escolhida ─────────
      let proximoStatus: string | null = null;
      let novoAgendamento: { id: string; ordem: number; data: string } | null = null;

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
      } else {
        // 'manter' — não toca em outros agendamentos nem no processo.
        proximoStatus = 'dia_teste';
      }

      // Aprovação no dia de teste = candidato segue pra pré-admissão.
      // Cria usuário provisório + solicitação de admissão (mesmo trilho do
      // caminho B em /recrutamento/processos), e linka ao processo_seletivo.
      // Sem isso, o processo fica em 'pre_admissao' sem provisório nem form
      // pra preencher — é o gap que travava a continuação do fluxo.
      let provisorioInfo: {
        provisorioId: number;
        solicitacaoId: string;
        reutilizado: boolean;
        readmissao: boolean;
      } | null = null;

      if (acao === 'encerrar' && proximoStatus === 'pre_admissao') {
        const ctxRes = await query<{
          empresa_id: number;
          cargo_id: number;
          departamento_id: number;
          jornada_id: number;
        }>(
          `SELECT empresa_id, cargo_id, departamento_id, jornada_id
             FROM people.processo_seletivo
            WHERE id = $1::bigint
            LIMIT 1`,
          [ag.processo_seletivo_id],
        );
        const ctx = ctxRes.rows[0];
        if (!ctx) {
          return serverErrorResponse('Processo seletivo não encontrado para criar pré-admissão');
        }

        // Nome do candidato vem do banco externo de Recrutamento.
        // Best-effort: se cair, usa fallback genérico — não bloqueia.
        let nomeCandidato = `Candidato ${ag.candidato_cpf_norm}`;
        try {
          const nRes = await queryRecrutamento<{ nome: string | null }>(
            `SELECT nome FROM public.candidatos WHERE id = $1 LIMIT 1`,
            [Number(ag.candidato_recrutamento_id)],
          );
          const n = nRes.rows[0]?.nome?.trim();
          if (n) nomeCandidato = n;
        } catch (e) {
          console.warn('[dia-teste/aprovar] falha ao buscar nome do candidato:', e);
        }

        const resProv = await criarOuReaproveitarProvisorio(
          {
            nome: nomeCandidato,
            cpf: ag.candidato_cpf_norm,
            empresaId: Number(ctx.empresa_id),
            cargoId: Number(ctx.cargo_id),
            departamentoId: Number(ctx.departamento_id),
            jornadaId: Number(ctx.jornada_id),
            diasTeste: null,
          },
          user.userId,
        );

        if (!resProv.ok) {
          // Aprovação já comitada — registra falha em audit pra gestor
          // resolver manualmente, e retorna 500 com diagnóstico claro.
          console.error('[dia-teste/aprovar] falha ao criar provisório/solicitação:', resProv.erro);
          await registrarAuditoria(
            buildAuditParams(req, user, {
              acao: 'editar',
              modulo: 'recrutamento_dia_teste',
              descricao: `Aprovação registrada (#${id}) mas pré-admissão NÃO foi criada (${resProv.erro.code}) — intervenção manual necessária`,
              dadosNovos: {
                agendamentoId: id,
                processoId: ag.processo_seletivo_id,
                erroProvisorio: resProv.erro,
              },
            }),
          );
          const erro = resProv.erro;
          let detalhe = 'erro desconhecido';
          switch (erro.code) {
            case 'cpf_invalido':
              detalhe = 'CPF do candidato inválido';
              break;
            case 'colaborador_ativo':
              detalhe = 'já existe colaborador ativo com este CPF';
              break;
            case 'processo_em_andamento':
              detalhe = 'já existe processo de admissão em andamento para este CPF';
              break;
            case 'fk_invalida':
              detalhe = `${erro.campo} (id ${erro.id}) não encontrada`;
              break;
            case 'sem_formulario_ativo':
              detalhe = 'nenhum formulário de admissão ativo configurado';
              break;
          }
          return errorResponse(
            `Candidato aprovado, mas a pré-admissão não pôde ser criada: ${detalhe}. Contate o administrador.`,
            500,
          );
        }

        await query(
          `UPDATE people.processo_seletivo
              SET usuario_provisorio_id = $1,
                  solicitacao_admissao_id = $2::uuid,
                  atualizado_em = NOW()
            WHERE id = $3::bigint`,
          [
            resProv.data.provRow.id,
            resProv.data.solicitacaoId,
            ag.processo_seletivo_id,
          ],
        );

        provisorioInfo = {
          provisorioId: resProv.data.provRow.id,
          solicitacaoId: resProv.data.solicitacaoId,
          reutilizado: resProv.data.reutilizado,
          readmissao: resProv.data.readmissao,
        };
      }

      const descAcao =
        acao === 'encerrar'
          ? 'segue para pré-admissão'
          : acao === 'adicionar_dia'
            ? `mantido em teste — novo dia agendado (${novoAgendamento?.data}, ordem ${novoAgendamento?.ordem})`
            : 'mantido em teste — aguardando próximo dia já agendado';

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato APROVADO no dia de teste #${id} (a pagar: R$ ${total.valorTotal.toFixed(2)} = R$ ${total.valorDiasAnteriores.toFixed(2)} dias anteriores + R$ ${total.valorAgendamentoAtual.toFixed(2)} hoje); ${descAcao}`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            acao,
            periodosCumpridos: total.periodosAtual,
            percentualConcluido: total.percentualAtual,
            valorAgendamentoAtual: total.valorAgendamentoAtual,
            valorDiasAnteriores: total.valorDiasAnteriores,
            valorTotal: total.valorTotal,
            observacao: parsed.data.observacao ?? null,
            provisorio: provisorioInfo,
            novoAgendamento,
          },
        }),
      );

      // Formato esperado pelo mobile (DecisaoDiaTesteResponse): chaves
      // valorAPagar e proximoPasso indicam que é uma decisão.
      // valorAPagar = total cumulativo do processo (dias anteriores +
      // período atual). valorAgendamentoAtual = só o agendamento atual.
      const proximoPasso =
        acao === 'encerrar'
          ? proximoStatus === 'pre_admissao' ? 'pre_admissao' : 'encerrado'
          : acao === 'adicionar_dia'
            ? 'novo_dia_agendado'
            : 'manter_em_teste';

      return successResponse({
        agendamentoId: id,
        status: 'aprovado',
        acao,
        valorAPagar: total.valorTotal,
        valorAgendamentoAtual: total.valorAgendamentoAtual,
        valorDiasAnteriores: total.valorDiasAnteriores,
        periodosCumpridos: total.periodosAtual,
        percentualConcluido: total.percentualAtual,
        decididoEm: new Date().toISOString(),
        proximoPasso,
        processo: {
          id: ag.processo_seletivo_id,
          status: proximoStatus,
        },
        provisorio: provisorioInfo,
        novoAgendamento,
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
