import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const ano = searchParams.get('ano');
      const tipo = searchParams.get('tipo');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.FERIADOS, { pagina, limite, ano, tipo });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (ano) {
          conditions.push(`EXTRACT(YEAR FROM data) = $${paramIndex}`);
          params.push(parseInt(ano));
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM bt_feriados ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT id, nome, data, tipo, recorrente, abrangencia
           FROM bt_feriados
           ${whereClause}
           ORDER BY data ASC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          nome: row.nome,
          data: row.data,
          tipo: row.tipo,
          recorrente: row.recorrente,
          abrangencia: row.abrangencia,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.LONG);

      return successResponse(buildPaginatedResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite));
    } catch (error) {
      console.error('Erro ao listar feriados:', error);
      return serverErrorResponse('Erro ao listar feriados');
    }
  });
}
