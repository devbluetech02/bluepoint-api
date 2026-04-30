import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/cargos/:id/colaboradores
// Lista os colaboradores ATIVOS de um cargo, com flag indicando se possui
// overrides individuais ativos. Usado pela aba "Colaboradores" no modal
// de cargo, pra editar permissões pessoais.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(request, async () => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id, 10);
      if (Number.isNaN(cargoId) || cargoId <= 0) {
        return errorResponse('ID inválido', 400);
      }

      const cargoResult = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.cargos WHERE id = $1 LIMIT 1`,
        [cargoId],
      );
      if (cargoResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }
      const cargo = cargoResult.rows[0];

      const r = await query<{
        id: number;
        nome: string;
        email: string;
        foto_url: string | null;
        status: string;
        departamento_id: number | null;
        departamento_nome: string | null;
        empresa_id: number | null;
        empresa_nome: string | null;
        total_overrides: number;
      }>(
        `SELECT c.id, c.nome, c.email, c.foto_url, c.status,
                d.id AS departamento_id, d.nome AS departamento_nome,
                e.id AS empresa_id, e.nome_fantasia AS empresa_nome,
                COALESCE(ov.total, 0)::int AS total_overrides
           FROM people.colaboradores c
           LEFT JOIN people.departamentos d ON d.id = c.departamento_id
           LEFT JOIN people.empresas e ON e.id = c.empresa_id
           LEFT JOIN (
             SELECT colaborador_id, COUNT(*) AS total
               FROM people.colaborador_permissoes_override
              GROUP BY colaborador_id
           ) ov ON ov.colaborador_id = c.id
          WHERE c.cargo_id = $1
          ORDER BY c.nome ASC`,
        [cargoId],
      );

      return successResponse({
        cargo: { id: cargo.id, nome: cargo.nome },
        total: r.rows.length,
        colaboradores: r.rows.map((row) => ({
          id: row.id,
          nome: row.nome,
          email: row.email,
          foto: row.foto_url,
          status: row.status,
          departamento: row.departamento_id
            ? { id: row.departamento_id, nome: row.departamento_nome }
            : null,
          empresa: row.empresa_id
            ? { id: row.empresa_id, nomeFantasia: row.empresa_nome }
            : null,
          totalOverrides: row.total_overrides,
        })),
      });
    } catch (error) {
      console.error('[cargos/:id/colaboradores] erro GET:', error);
      return serverErrorResponse('Erro ao listar colaboradores do cargo');
    }
  });
}
