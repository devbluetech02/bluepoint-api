import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getDayName } from '@/lib/utils';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ ano: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { ano: anoStr } = await params;
      const ano = parseInt(anoStr);

      if (isNaN(ano) || ano < 1900 || ano > 2100) {
        return successResponse({ ano: anoStr, feriados: [], total: 0 });
      }

      const cacheKey = `${CACHE_KEYS.FERIADOS}ano:${ano}`;

      const dados = await cacheAside(cacheKey, async () => {

      // Buscar feriados do ano (incluindo recorrentes)
      const result = await query(
        `SELECT id, nome, data, tipo
         FROM bt_feriados
         WHERE EXTRACT(YEAR FROM data) = $1 
            OR (recorrente = true AND EXTRACT(YEAR FROM data) <= $1)
         ORDER BY EXTRACT(MONTH FROM data), EXTRACT(DAY FROM data)`,
        [ano]
      );

      const feriados = result.rows.map(row => {
        const data = new Date(row.data);
        // Se é recorrente, ajustar para o ano solicitado
        if (data.getFullYear() !== ano) {
          data.setFullYear(ano);
        }
        
        return {
          id: row.id,
          nome: row.nome,
          data: data.toISOString().split('T')[0],
          tipo: row.tipo,
          diaSemana: getDayName(data.getDay()),
        };
      });

      return {
        ano,
        feriados,
        total: feriados.length,
      };
      }, CACHE_TTL.LONG);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar feriados do ano:', error);
      return serverErrorResponse('Erro ao listar feriados');
    }
  });
}
