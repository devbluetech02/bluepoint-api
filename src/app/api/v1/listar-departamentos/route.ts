import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const status = searchParams.get('status');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.DEPARTAMENTOS, { pagina, limite, status });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (status) {
          conditions.push(`d.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM bt_departamentos d ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            d.id,
            d.nome,
            d.descricao,
            d.status,
            g.id as gestor_id,
            g.nome as gestor_nome,
            (SELECT COUNT(*) FROM bluepoint.bt_colaboradores WHERE departamento_id = d.id AND status = 'ativo') as total_colaboradores
          FROM bt_departamentos d
          LEFT JOIN bluepoint.bt_colaboradores g ON d.gestor_id = g.id
          ${whereClause}
          ORDER BY d.nome ASC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          nome: row.nome,
          descricao: row.descricao,
          gestor: row.gestor_id ? { id: row.gestor_id, nome: row.gestor_nome } : null,
          totalColaboradores: parseInt(row.total_colaboradores),
          status: row.status,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.MEDIUM);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar departamentos:', error);
      return serverErrorResponse('Erro ao listar departamentos');
    }
  });
}
