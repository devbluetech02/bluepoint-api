import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  createdResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { criarOuReaproveitarProvisorio } from '@/lib/usuarios-provisorios';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import {
  enviarMensagemWhatsApp,
  enviarMidiaWhatsApp,
} from '@/lib/evolution-api';
import { cancelarDocumentoSignProof } from '@/lib/recrutamento-dia-teste';

// POST /api/v1/recrutamento/processos/:id/converter-pre-admissao
//
// Move um candidato que estava no caminho A (dia de teste) direto pra
// caminho B (pré-admissão). Use case: gestor decide pular o teste e
// admitir direto.
//
// Faz, em uma operação:
//   1. Cancela o processo atual (status 'dia_teste' ou 'aberto').
//      - Marca processo como 'cancelado' + cancela agendamentos futuros.
//      - Cancela documento na SignProof (best-effort, fora da transação).
//   2. Abre processo novo no caminho B reaproveitando os mesmos
//      empresa/cargo/departamento/jornada/candidato.
//      - Cria provisório via criarOuReaproveitarProvisorio.
//      - Dispara WhatsApp de pré-admissão (best-effort).
//
// Body opcional:
//   - motivoCancelamento: string (registrado no processo cancelado)
//   - mensagemWhatsApp:   string (sobrescreve mensagem default)

const schema = z.object({
  motivoCancelamento: z.string().max(2000).optional().nullable(),
  mensagemWhatsApp: z.string().max(2000).optional().nullable(),
});

const MENSAGEM_WHATSAPP_DEFAULT = (nome: string) => {
  const primeiroNome = nome.split(' ')[0];
  return `Olá, ${primeiroNome}! Aqui é o João, do DP da Bluetech Window Films. Parabéns, você foi aprovado no nosso processo seletivo! 🎉

Para seguir com sua admissão, baixe o app *People*:

📱 iPhone: https://apps.apple.com/br/app/people-by-valeris/id6761028795
🤖 Android: https://play.google.com/store/apps/details?id=com.people.valeris

No 1º acesso, permita as autorizações, toque em *Área do colaborador → Primeiro acesso* e informe seu *CPF*.

Qualquer dúvida, estou à disposição. Salve nosso contato (DP) para receber informações futuras.`;
};

function conflictWithCode(message: string, code: string) {
  return NextResponse.json({ success: false, error: message, code }, { status: 409 });
}

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
      const motivo = parsed.data.motivoCancelamento?.trim() || 'Convertido para pré-admissão direta';
      const mensagemWhatsappOverride = parsed.data.mensagemWhatsApp?.trim() || null;

      // 1) Carrega processo atual com todos os campos pra reabrir.
      const procResult = await query<{
        id: string;
        status: string;
        caminho: string;
        candidato_recrutamento_id: number | null;
        candidato_cpf_norm: string;
        usuario_provisorio_id: number | null;
        documento_assinatura_id: string | null;
        empresa_id: number | null;
        cargo_id: number | null;
        departamento_id: number | null;
        jornada_id: number | null;
      }>(
        `SELECT id::text, status, caminho,
                candidato_recrutamento_id, candidato_cpf_norm,
                usuario_provisorio_id, documento_assinatura_id,
                empresa_id, cargo_id, departamento_id, jornada_id
           FROM people.processo_seletivo
          WHERE id = $1::bigint
          LIMIT 1`,
        [id],
      );
      const proc = procResult.rows[0];
      if (!proc) {
        return notFoundResponse('Processo seletivo não encontrado');
      }

      if (proc.status === 'admitido') {
        return errorResponse(
          'Processo já admitido — não é possível converter para pré-admissão',
          409,
        );
      }
      if (proc.status === 'cancelado') {
        return errorResponse('Processo já está cancelado', 409);
      }
      if (proc.status === 'pre_admissao') {
        return errorResponse('Processo já está em pré-admissão', 409);
      }
      if (proc.empresa_id == null || proc.cargo_id == null || proc.departamento_id == null || proc.jornada_id == null) {
        return errorResponse(
          'Processo atual não tem todos os vínculos preenchidos (empresa/cargo/departamento/jornada). Não é possível converter automaticamente.',
          400,
        );
      }
      if (!proc.candidato_recrutamento_id) {
        return errorResponse('Processo atual não está vinculado ao banco de Recrutamento', 400);
      }

      const cpfNorm = proc.candidato_cpf_norm;
      const etapaAnterior = proc.status;

      // 2) Carrega candidato no banco de Recrutamento (nome, telefone, vaga).
      const candResult = await queryRecrutamento<{
        id: number;
        nome: string;
        telefone: string | null;
        vaga: string | null;
      }>(
        `SELECT id, nome, telefone, vaga
           FROM public.candidatos
          WHERE id = $1
            AND regexp_replace(cpf, '\\D', '', 'g') = $2
          LIMIT 1`,
        [proc.candidato_recrutamento_id, cpfNorm],
      );
      const candidato = candResult.rows[0];
      if (!candidato) {
        return errorResponse(
          'Candidato vinculado não encontrado no banco de Recrutamento',
          404,
        );
      }

      // 3) Veta CPF que já é colaborador ATIVO.
      const colabAtivo = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.colaboradores
          WHERE regexp_replace(cpf, '\\D', '', 'g') = $1
            AND status = 'ativo'
          LIMIT 1`,
        [cpfNorm],
      );
      if (colabAtivo.rows[0]) {
        return conflictWithCode(
          `CPF ${cpfNorm} já é colaborador ativo (id ${colabAtivo.rows[0].id}, ${colabAtivo.rows[0].nome}).`,
          'colaborador_ativo',
        );
      }

      // 4) Transação: cancela atual + agendamentos + provisório, cria
      //    provisório novo + processo novo.
      let agendamentosCancelados = 0;
      let novoProcessoId: string | null = null;
      let resultadoProv: Awaited<ReturnType<typeof criarOuReaproveitarProvisorio>> | null = null;

      await query('BEGIN', []);
      try {
        // 4a) Cancela processo atual.
        await query(
          `UPDATE people.processo_seletivo
              SET status              = 'cancelado',
                  cancelado_por       = $1,
                  cancelado_em        = NOW(),
                  cancelado_em_etapa  = $2,
                  motivo_cancelamento = $3,
                  atualizado_em       = NOW()
            WHERE id = $4::bigint`,
          [user.userId, etapaAnterior, motivo, id],
        );

        // 4b) Cancela agendamentos futuros (caso seja dia_teste).
        if (etapaAnterior === 'dia_teste') {
          const updAg = await query(
            `UPDATE people.dia_teste_agendamento
                SET status = 'cancelado',
                    atualizado_em = NOW()
              WHERE processo_seletivo_id = $1::bigint
                AND status IN ('agendado','compareceu')
                AND data >= CURRENT_DATE`,
            [id],
          );
          agendamentosCancelados = updAg.rowCount ?? 0;
        }

        // 4c) Inativa provisório do processo antigo, se houver.
        if (proc.usuario_provisorio_id) {
          await query(
            `UPDATE people.usuarios_provisorios
                SET status = 'inativo', atualizado_em = NOW()
              WHERE id = $1 AND status = 'ativo'`,
            [proc.usuario_provisorio_id],
          );
        }

        // 4d) Cria/reaproveita provisório + solicitação de admissão.
        resultadoProv = await criarOuReaproveitarProvisorio(
          {
            nome: candidato.nome,
            cpf: cpfNorm,
            empresaId: proc.empresa_id,
            cargoId: proc.cargo_id,
            departamentoId: proc.departamento_id,
            jornadaId: proc.jornada_id,
            diasTeste: null,
          },
          user.userId,
        );

        if (!resultadoProv.ok) {
          await query('ROLLBACK', []);
        } else {
          // 4e) Cria novo processo_seletivo no caminho pre_admissao.
          const procIns = await query<{ id: string }>(
            `INSERT INTO people.processo_seletivo
               (candidato_recrutamento_id, candidato_cpf_norm, vaga_snapshot,
                usuario_provisorio_id, solicitacao_admissao_id,
                empresa_id, cargo_id, departamento_id, jornada_id,
                status, caminho, criado_por)
             VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9,
                     'pre_admissao', 'pre_admissao', $10)
             RETURNING id::text`,
            [
              proc.candidato_recrutamento_id,
              cpfNorm,
              candidato.vaga,
              resultadoProv.data.provRow.id,
              resultadoProv.data.solicitacaoId,
              proc.empresa_id,
              proc.cargo_id,
              proc.departamento_id,
              proc.jornada_id,
              user.userId,
            ],
          );
          novoProcessoId = procIns.rows[0].id;
          await query('COMMIT', []);
        }
      } catch (txErr) {
        await query('ROLLBACK', []);
        throw txErr;
      }

      if (!resultadoProv || !resultadoProv.ok) {
        const erro = resultadoProv?.erro;
        switch (erro?.code) {
          case 'cpf_invalido':
            return errorResponse('CPF inválido', 400);
          case 'colaborador_ativo':
            return conflictWithCode('Há um colaborador ativo com este CPF', 'colaborador_ativo');
          case 'processo_em_andamento':
            return conflictWithCode(
              'Há um processo de admissão em andamento para este CPF',
              'processo_em_andamento',
            );
          case 'fk_invalida':
            return errorResponse(`${erro.campo} não encontrada: ${erro.id}`, 400);
          case 'sem_formulario_ativo':
            return serverErrorResponse('Nenhum formulário de admissão ativo');
          default:
            return serverErrorResponse('Falha ao criar provisório');
        }
      }

      const { provRow, solicitacaoId, reutilizado, readmissao } = resultadoProv.data;

      // 5) Cancela documento SignProof do processo anterior (best-effort).
      let signProofCancelado: boolean | null = null;
      let signProofErro: string | null = null;
      if (proc.documento_assinatura_id) {
        const r = await cancelarDocumentoSignProof(proc.documento_assinatura_id);
        signProofCancelado = r.ok;
        signProofErro = r.ok ? null : r.erro ?? 'desconhecido';
        if (!r.ok) {
          console.warn(
            `[recrutamento/processos/:id/converter-pre-admissao] SignProof cancel falhou para doc ${proc.documento_assinatura_id}:`,
            r.erro,
          );
        }
      }

      // 6) WhatsApp de pré-admissão (best-effort).
      const numeroWhats = (candidato.telefone ?? '').replace(/\D/g, '');
      let whatsappOk = false;
      let whatsappErro: string | null = null;
      if (numeroWhats) {
        const texto = mensagemWhatsappOverride || MENSAGEM_WHATSAPP_DEFAULT(provRow.nome);
        const videoUrl = process.env.WHATSAPP_VIDEO_PRE_ADMISSAO_URL?.trim();
        if (videoUrl) {
          const result = await enviarMidiaWhatsApp(numeroWhats, videoUrl, {
            mediatype: 'video',
            caption: texto,
            fileName: 'pre-admissao.mp4',
            mimetype: 'video/mp4',
          });
          if (result.ok) {
            whatsappOk = true;
          } else {
            const fallback = await enviarMensagemWhatsApp(numeroWhats, texto);
            whatsappOk = fallback.ok;
            whatsappErro = fallback.ok
              ? `video_falhou_${result.erro}`
              : fallback.erro ?? null;
          }
        } else {
          const result = await enviarMensagemWhatsApp(numeroWhats, texto);
          whatsappOk = result.ok;
          whatsappErro = result.erro ?? null;
        }
      } else {
        whatsappErro = 'sem_telefone';
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'recrutamento_processo_seletivo',
        descricao: `Processo seletivo ${id} convertido para pré-admissão direta. Novo processo ${novoProcessoId}.`,
        dadosNovos: {
          processoCanceladoId: id,
          etapaAnterior,
          motivo,
          agendamentosCancelados,
          signProofCancelado,
          signProofErro,
          novoProcessoId,
          novoSolicitacaoId: solicitacaoId,
          provisorioId: provRow.id,
          whatsappOk,
          whatsappErro,
          reutilizado,
          readmissao,
        },
      }));

      const payload = {
        processoCanceladoId: id,
        agendamentosCancelados,
        signProofCancelado,
        signProofErro,
        novoProcessoId,
        provisorio: {
          id: provRow.id,
          nome: provRow.nome,
          cpf: provRow.cpf,
          empresaId: provRow.empresa_id,
          cargoId: provRow.cargo_id,
          departamentoId: provRow.departamento_id,
          jornadaId: provRow.jornada_id,
          status: provRow.status,
          criadoEm: provRow.criado_em,
        },
        solicitacaoId,
        reutilizado,
        readmissao,
        whatsapp: { enviado: whatsappOk, erro: whatsappErro },
      };

      return reutilizado ? successResponse(payload) : createdResponse(payload);
    } catch (error) {
      console.error('[recrutamento/processos/:id/converter-pre-admissao] erro:', error);
      return serverErrorResponse('Erro ao converter processo para pré-admissão');
    }
  });
}
