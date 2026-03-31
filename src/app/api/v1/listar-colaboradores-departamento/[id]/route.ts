import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req) => {
    try {
      const { id } = await params;
      const departamentoId = parseInt(id);

      if (isNaN(departamentoId)) {
        return notFoundResponse('Departamento não encontrado');
      }

      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const status = searchParams.get('status');

      // Verificar se departamento existe
      const deptResult = await query(
        `SELECT id, nome FROM departamentos WHERE id = $1`,
        [departamentoId]
      );

      if (deptResult.rows.length === 0) {
        return notFoundResponse('Departamento não encontrado');
      }

      const departamento = deptResult.rows[0];

      const cacheKey = buildListCacheKey(CACHE_KEYS.COLABORADORES, {
        tipo: 'departamento', departamentoId, pagina, limite, status,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      // Construir filtros
      const conditions: string[] = ['departamento_id = $1'];
      const params_query: unknown[] = [departamentoId];
      let paramIndex = 2;

      if (status) {
        conditions.push(`status = $${paramIndex}`);
        params_query.push(status);
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total FROM people.colaboradores ${whereClause}`,
        params_query
      );
      const total = parseInt(countResult.rows[0].total);

      // Buscar colaboradores
      const dataParams = [...params_query, limite, offset];
      const result = await query(
        `SELECT c.id, c.nome, c.email, c.cargo_id, cg.nome as cargo_nome, c.status, c.foto_url
         FROM people.colaboradores c
         LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
         ${whereClause.replace(/departamento_id/g, 'c.departamento_id').replace(/status/g, 'c.status')}
         ORDER BY c.nome ASC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const colaboradores = result.rows.map(row => ({
        id: row.id,
        nome: row.nome,
        email: row.email,
        cargo: row.cargo_id ? { id: row.cargo_id, nome: row.cargo_nome } : null,
        status: row.status,
        foto: row.foto_url,
      }));

      return {
        departamento: { id: departamento.id, nome: departamento.nome },
        ...buildPaginatedResponse(colaboradores, total, pagina, limite),
      };
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar colaboradores do departamento:', error);
      return serverErrorResponse('Erro ao listar colaboradores');
    }
  });
}
