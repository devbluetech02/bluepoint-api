import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/colaboradores/:id/permissoes/override/:permissaoId
// Remove o override individual e o colaborador volta ao default do cargo.
// ─────────────────────────────────────────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; permissaoId: string }> },
) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id, permissaoId: permIdStr } = await params;
      const colaboradorId = parseInt(id, 10);
      const permissaoId = parseInt(permIdStr, 10);
      if (
        Number.isNaN(colaboradorId) || colaboradorId <= 0 ||
        Number.isNaN(permissaoId) || permissaoId <= 0
      ) {
        return errorResponse('IDs inválidos', 400);
      }

      const colabResult = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 LIMIT 1`,
        [colaboradorId],
      );
      if (colabResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }
      const colab = colabResult.rows[0];

      const r = await query<{ concedido: boolean; motivo: string | null; codigo: string }>(
        `DELETE FROM people.colaborador_permissoes_override cpo
          USING people.permissoes p
          WHERE cpo.colaborador_id = $1
            AND cpo.permissao_id = $2
            AND p.id = cpo.permissao_id
          RETURNING cpo.concedido, cpo.motivo, p.codigo`,
        [colaboradorId, permissaoId],
      );
      if (r.rows.length === 0) {
        return notFoundResponse('Override não encontrado');
      }
      const removido = r.rows[0];

      try {
        await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}:*`);
      } catch (_) {
        // best-effort
      }

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'excluir',
          modulo: 'colaboradores',
          descricao: `Override de permissão "${removido.codigo}" removido de "${colab.nome}" (#${colab.id}) — volta ao default do cargo`,
          dadosAnteriores: { concedido: removido.concedido, motivo: removido.motivo },
        }),
      );

      return successResponse({
        colaborador: { id: colab.id, nome: colab.nome },
        permissaoId,
        mensagem: 'Override removido — colaborador volta ao default do cargo',
      });
    } catch (error) {
      console.error('[colaboradores/:id/permissoes/override/:permissaoId] erro DELETE:', error);
      return serverErrorResponse('Erro ao remover override');
    }
  });
}
