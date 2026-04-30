import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/colaboradores/:id/permissoes/override
// Body: { permissaoId, concedido, motivo? } — upsert do override individual.
// Override(true)  → concede mesmo se cargo remove.
// Override(false) → remove mesmo se cargo concede.
// Para voltar ao default do cargo, usar DELETE no endpoint
// /override/[permissaoId].
// ─────────────────────────────────────────────────────────────────────────────

const putSchema = z.object({
  permissaoId: z.number().int().positive(),
  concedido: z.boolean(),
  motivo: z.string().trim().max(500).optional().nullable(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id, 10);
      if (Number.isNaN(colaboradorId) || colaboradorId <= 0) {
        return errorResponse('ID inválido', 400);
      }

      const body = await req.json().catch(() => ({}));
      const parsed = putSchema.safeParse(body);
      if (!parsed.success) {
        return validationErrorResponse({
          body: parsed.error.issues.map((i) => i.message),
        });
      }
      const { permissaoId, concedido, motivo } = parsed.data;

      const colabResult = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 LIMIT 1`,
        [colaboradorId],
      );
      if (colabResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }
      const colab = colabResult.rows[0];

      const permResult = await query<{ id: number; codigo: string; nome: string }>(
        `SELECT id, codigo, nome FROM people.permissoes WHERE id = $1 LIMIT 1`,
        [permissaoId],
      );
      if (permResult.rows.length === 0) {
        return notFoundResponse('Permissão não encontrada');
      }
      const perm = permResult.rows[0];

      const anterior = await query<{ concedido: boolean; motivo: string | null }>(
        `SELECT concedido, motivo
           FROM people.colaborador_permissoes_override
          WHERE colaborador_id = $1 AND permissao_id = $2`,
        [colaboradorId, permissaoId],
      );

      await query(
        `INSERT INTO people.colaborador_permissoes_override
           (colaborador_id, permissao_id, concedido, motivo, atualizado_por)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (colaborador_id, permissao_id) DO UPDATE
           SET concedido = EXCLUDED.concedido,
               motivo = EXCLUDED.motivo,
               atualizado_por = EXCLUDED.atualizado_por`,
        [colaboradorId, permissaoId, concedido, motivo ?? null, user.userId > 0 ? user.userId : null],
      );

      // Invalida cache de permissões efetivas (caso exista)
      try {
        await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}:*`);
      } catch (_) {
        // cache best-effort
      }

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'colaboradores',
          descricao: `Override de permissão "${perm.codigo}" ${concedido ? 'concedido' : 'removido'} para "${colab.nome}" (#${colab.id})`,
          dadosAnteriores: anterior.rows[0] ?? null,
          dadosNovos: { permissaoId, concedido, motivo: motivo ?? null },
        }),
      );

      return successResponse({
        colaborador: { id: colab.id, nome: colab.nome },
        permissao: { id: perm.id, codigo: perm.codigo, nome: perm.nome },
        concedido,
        motivo: motivo ?? null,
      });
    } catch (error) {
      console.error('[colaboradores/:id/permissoes/override] erro PUT:', error);
      return serverErrorResponse('Erro ao salvar override de permissão');
    }
  });
}
