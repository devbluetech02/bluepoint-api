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

// POST /api/v1/recrutamento/processos/:id/cancelar
//
// Cancelamento pelo RH (FLUXO_RECRUTAMENTO.md §5).
// - Bloqueia se status = 'admitido' ou 'cancelado'.
// - Persiste cancelado_por/em/etapa/motivo.
// - Sprint 1: caminho A ainda não existe, então não há contrato Sign Proof
//   pra cancelar nem dias de teste. A lógica de cancelar SignProof entrará
//   na Sprint 2 quando o caminho A for implementado.
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
        candidato_cpf_norm: string;
        usuario_provisorio_id: number | null;
      }>(
        `SELECT id::text, status, candidato_cpf_norm, usuario_provisorio_id
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

      const etapa = proc.status; // 'aberto' | 'pre_admissao'

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

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'recrutamento_processo_seletivo',
        descricao: `Processo seletivo ${id} cancelado pelo RH na etapa "${etapa}".`,
        dadosNovos: { processoId: id, etapa, motivo },
      }));

      return successResponse({
        id,
        status: 'cancelado',
        canceladoEmEtapa: etapa,
        motivo,
      });
    } catch (error) {
      console.error('[recrutamento/processos/:id/cancelar] erro:', error);
      return serverErrorResponse('Erro ao cancelar processo');
    }
  });
}
