import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const busca = searchParams.get('busca');

      // Cache key baseada nos parâmetros de paginação e busca
      const cacheKey = `${CACHE_KEYS.CARGOS}list:${pagina}:${limite}:${busca || ''}`;

      // Usar cache-aside pattern
      const result = await cacheAside(
        cacheKey,
        async () => {
          const conditions: string[] = [];
          const params: unknown[] = [];
          let paramIndex = 1;

          // Filtro de busca por nome, CBO ou descrição
          if (busca) {
            conditions.push(
              `(LOWER(nome) LIKE $${paramIndex} OR LOWER(cbo) LIKE $${paramIndex} OR LOWER(descricao) LIKE $${paramIndex})`
            );
            params.push(`%${busca.toLowerCase()}%`);
            paramIndex++;
          }

          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

          // Contar total
          const countResult = await query(
            `SELECT COUNT(*) as total FROM people.cargos ${whereClause}`,
            params
          );
          const total = parseInt(countResult.rows[0].total);

          // Buscar cargos
          const dataParams = [...params, limite, offset];
          const dataResult = await query(
            `SELECT id, nome, cbo, descricao, salario_padrao, templates_contrato_admissao,
                    template_dia_teste, nivel_acesso_id, created_at, updated_at
             FROM people.cargos
             ${whereClause}
             ORDER BY nome ASC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            dataParams
          );

          const cargoIds = dataResult.rows.map((c) => c.id as number);
          const examesPorCargo = new Map<number, { id: number; nome: string }[]>();

          if (cargoIds.length > 0) {
            const examesResult = await query(
              `SELECT ce.cargo_id, e.id, e.nome
               FROM people.cargos_exames ce
               JOIN people.exames e ON e.id = ce.exame_id
               WHERE ce.cargo_id = ANY($1::int[])
               ORDER BY e.nome ASC`,
              [cargoIds]
            );
            for (const row of examesResult.rows as { cargo_id: number; id: number; nome: string }[]) {
              const lista = examesPorCargo.get(row.cargo_id) ?? [];
              lista.push({ id: row.id, nome: row.nome });
              examesPorCargo.set(row.cargo_id, lista);
            }
          }

          const dados = dataResult.rows.map(cargo => ({
            id: cargo.id,
            nome: cargo.nome,
            cbo: cargo.cbo,
            descricao: cargo.descricao,
            salarioPadrao: cargo.salario_padrao ? parseFloat(cargo.salario_padrao) : null,
            templatesContratoAdmissao: cargo.templates_contrato_admissao ?? [],
            templateDiaTeste: cargo.template_dia_teste ?? null,
            nivelAcessoId: cargo.nivel_acesso_id ?? null,
            exames: examesPorCargo.get(cargo.id) ?? [],
            criadoEm: cargo.created_at,
            atualizadoEm: cargo.updated_at,
          }));

          return buildPaginatedResponse(dados, total, pagina, limite);
        },
        CACHE_TTL.LONG // Cargos raramente mudam - cache de 1 hora
      );

      return successResponse(result);
    } catch (error) {
      console.error('Erro ao listar cargos:', error);
      return serverErrorResponse('Erro ao listar cargos');
    }
  });
}
