import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const status = searchParams.get('status');
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');

      const conditions: string[] = [
        `(r.anfitriao_id = $1 OR rp.colaborador_id = $1)`,
      ];
      const params: unknown[] = [user.userId];
      let paramIndex = 2;

      if (status) {
        conditions.push(`r.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }

      if (dataInicio) {
        conditions.push(`r.data_inicio >= $${paramIndex}`);
        params.push(new Date(dataInicio));
        paramIndex++;
      }

      if (dataFim) {
        conditions.push(`r.data_inicio <= $${paramIndex}`);
        params.push(new Date(dataFim));
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const countResult = await query(
        `SELECT COUNT(DISTINCT r.id) AS total
         FROM people.reunioes r
         LEFT JOIN people.reunioes_participantes rp ON rp.reuniao_id = r.id
         ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total, 10);

      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT DISTINCT ON (r.data_inicio, r.id)
          r.id,
          r.sala,
          r.titulo,
          r.descricao,
          r.data_inicio,
          r.data_fim,
          r.status,
          r.anfitriao_id,
          a.nome AS anfitriao_nome,
          r.criado_em
        FROM people.reunioes r
        LEFT JOIN people.reunioes_participantes rp ON rp.reuniao_id = r.id
        JOIN people.colaboradores a ON r.anfitriao_id = a.id
        ${whereClause}
        ORDER BY r.data_inicio DESC, r.id
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const reunioes = result.rows.map((row) => ({
        id: row.id,
        sala: row.sala,
        titulo: row.titulo,
        descricao: row.descricao,
        dataInicio: row.data_inicio,
        dataFim: row.data_fim,
        status: row.status,
        link: `/reuniao/${row.sala}`,
        anfitriao: {
          id: row.anfitriao_id,
          nome: row.anfitriao_nome,
        },
        criadoEm: row.criado_em,
      }));

      return paginatedSuccessResponse(reunioes, total, pagina, limite);
    } catch (error) {
      console.error('Erro ao listar reuniões:', error);
      return serverErrorResponse('Erro ao listar reuniões');
    }
  });
}
