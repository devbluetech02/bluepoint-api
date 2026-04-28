import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cancelarDocumentoSignProof } from '@/lib/recrutamento-dia-teste';

// POST /api/v1/recrutamento/processos/:id/cancelar
//
// Cancelamento pelo RH (FLUXO_RECRUTAMENTO.md §5).
//
// Regras:
// - Bloqueia se status = 'admitido' (já é colaborador — usar desligamento)
//   ou já 'cancelado'.
// - Aceita 'aberto', 'dia_teste' e 'pre_admissao'.
// - Para 'dia_teste':
//     · Cancela o documento na SignProof (mesmo se já assinado).
//     · Marca agendamentos com data >= hoje (e ainda 'agendado'/'compareceu')
//       como 'cancelado' — sem pagamento. Dias já decididos mantêm seu status
//       e seu valor_a_pagar (regra §3.6 do FLUXO).
//
// O cancelamento da pré-admissão (quando o processo já está nas mãos do DP)
// continua sendo feito pelo endpoint existente
// `/api/v1/admissao/solicitacoes/:id/cancelar` — não duplicamos aqui.

const schema = z.object({
  motivo: z.string().max(2000).optional().nullable(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const body = await req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }
      const motivo = parsed.data.motivo?.trim() || null;

      const procResult = await query<{
        id: string;
        status: string;
        caminho: string;
        candidato_cpf_norm: string;
        usuario_provisorio_id: number | null;
        documento_assinatura_id: string | null;
      }>(
        `SELECT id::text, status, caminho, candidato_cpf_norm,
                usuario_provisorio_id, documento_assinatura_id
           FROM people.processo_seletivo
          WHERE id = $1::bigint
          LIMIT 1`,
        [id]
      );
      const proc = procResult.rows[0];
      if (!proc) {
        return notFoundResponse('Processo seletivo não encontrado');
      }

      if (proc.status === 'admitido') {
        return errorResponse(
          'Processo já admitido — use o fluxo de desligamento, não cancelamento',
          409
        );
      }
      if (proc.status === 'cancelado') {
        return errorResponse('Processo já está cancelado', 409);
      }

      const etapa = proc.status; // 'aberto' | 'dia_teste' | 'pre_admissao'

      // ── Transação local: status + agendamentos + provisório ──────────
      let agendamentosCancelados = 0;
      await query('BEGIN', []);
      try {
        await query(
          `UPDATE people.processo_seletivo
              SET status              = 'cancelado',
                  cancelado_por       = $1,
                  cancelado_em        = NOW(),
                  cancelado_em_etapa  = $2,
                  motivo_cancelamento = $3,
                  atualizado_em       = NOW()
            WHERE id = $4::bigint`,
          [user.userId, etapa, motivo, id]
        );

        // Dias de teste futuros viram 'cancelado' (sem pagamento).
        // Dias já decididos (aprovado/reprovado/desistencia/nao_compareceu)
        // ou no passado mantêm o status — assim preservamos os pagamentos
        // devidos pelas regras §3.6.
        if (etapa === 'dia_teste') {
          const updAg = await query(
            `UPDATE people.dia_teste_agendamento
                SET status = 'cancelado',
                    atualizado_em = NOW()
              WHERE processo_seletivo_id = $1::bigint
                AND status IN ('agendado','compareceu')
                AND data >= CURRENT_DATE`,
            [id]
          );
          agendamentosCancelados = updAg.rowCount ?? 0;
        }

        // Marca o provisório como inativo se ainda não tiver virado colaborador.
        if (proc.usuario_provisorio_id) {
          await query(
            `UPDATE people.usuarios_provisorios
                SET status = 'inativo', atualizado_em = NOW()
              WHERE id = $1 AND status = 'ativo'`,
            [proc.usuario_provisorio_id]
          );
        }

        await query('COMMIT', []);
      } catch (txErr) {
        await query('ROLLBACK', []);
        throw txErr;
      }

      // ── SignProof cancel (best-effort, fora da transação) ────────────
      let signProofCancelado: boolean | null = null;
      let signProofErro: string | null = null;
      if (proc.documento_assinatura_id) {
        const r = await cancelarDocumentoSignProof(proc.documento_assinatura_id);
        signProofCancelado = r.ok;
        signProofErro = r.ok ? null : r.erro ?? 'desconhecido';
        if (!r.ok) {
          console.warn(
            `[recrutamento/processos/:id/cancelar] SignProof cancel falhou para doc ${proc.documento_assinatura_id}:`,
            r.erro
          );
        }
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'recrutamento_processo_seletivo',
        descricao: `Processo seletivo ${id} cancelado pelo RH na etapa "${etapa}".`,
        dadosNovos: {
          processoId: id,
          etapa,
          motivo,
          agendamentosCancelados,
          signProofCancelado,
          signProofErro,
        },
      }));

      return successResponse({
        id,
        status: 'cancelado',
        canceladoEmEtapa: etapa,
        motivo,
        agendamentosCancelados,
        signProofCancelado,
        signProofErro,
      });
    } catch (error) {
      console.error('[recrutamento/processos/:id/cancelar] erro:', error);
      return serverErrorResponse('Erro ao cancelar processo');
    }
  });
}
