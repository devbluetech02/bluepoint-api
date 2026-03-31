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
            `SELECT id, nome, cbo, descricao, salario_medio, valor_hora_extra_75, created_at, updated_at
             FROM people.cargos
             ${whereClause}
             ORDER BY nome ASC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            dataParams
          );

          const dados = dataResult.rows.map(cargo => ({
            id: cargo.id,
            nome: cargo.nome,
            cbo: cargo.cbo,
            descricao: cargo.descricao,
            salarioMedio: cargo.salario_medio ? parseFloat(cargo.salario_medio) : null,
            valorHoraExtra75: cargo.valor_hora_extra_75 ? parseFloat(cargo.valor_hora_extra_75) : null,
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
