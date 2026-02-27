import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const busca = searchParams.get('busca');

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (busca) {
        conditions.push(`(nome ILIKE $${paramIndex} OR descricao ILIKE $${paramIndex})`);
        params.push(`%${busca}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await query(
        `SELECT COUNT(*) as total FROM bluepoint.bt_modelos_exportacao ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT id, nome, descricao, ativo, criado_em, atualizado_em
         FROM bluepoint.bt_modelos_exportacao
         ${whereClause}
         ORDER BY criado_em DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const modelos = result.rows.map(row => ({
        id: row.id,
        nome: row.nome,
        descricao: row.descricao,
        ativo: row.ativo,
        criadoEm: row.criado_em,
        atualizadoEm: row.atualizado_em,
      }));

      return Response.json(buildPaginatedResponse(modelos, total, pagina, limite));
    } catch (error) {
      console.error('Erro ao listar modelos de exportação:', error);
      return serverErrorResponse('Erro ao listar modelos de exportação');
    }
  });
}
