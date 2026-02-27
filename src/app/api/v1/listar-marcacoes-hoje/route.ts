import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { formatDateISO } from '@/lib/utils';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const colaboradorId = searchParams.get('colaboradorId');
      const departamentoId = searchParams.get('departamentoId');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.MARCACOES_HOJE, { colaboradorId, departamentoId });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = ['DATE(m.data_hora) = CURRENT_DATE'];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (colaboradorId) {
          conditions.push(`m.colaborador_id = $${paramIndex}`);
          params.push(parseInt(colaboradorId));
          paramIndex++;
        }

        if (departamentoId) {
          conditions.push(`c.departamento_id = $${paramIndex}`);
          params.push(parseInt(departamentoId));
          paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        const result = await query(
          `SELECT 
            m.id,
            m.data_hora,
            m.tipo,
            m.foi_ajustada,
            c.id as colaborador_id,
            c.nome as colaborador_nome,
            d.nome as departamento_nome
          FROM bluepoint.bt_marcacoes m
          JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id
          LEFT JOIN bt_departamentos d ON c.departamento_id = d.id
          ${whereClause}
          ORDER BY m.data_hora DESC`,
          params
        );

        const marcacoes = result.rows.map(row => ({
          id: row.id,
          colaborador: {
            id: row.colaborador_id,
            nome: row.colaborador_nome,
            departamento: row.departamento_nome,
          },
          dataHora: row.data_hora,
          tipo: row.tipo,
          foiAjustada: row.foi_ajustada,
          status: 'registrado',
        }));

        return {
          data: formatDateISO(new Date()),
          marcacoes,
        };
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar marcações de hoje:', error);
      return serverErrorResponse('Erro ao listar marcações');
    }
  });
}
