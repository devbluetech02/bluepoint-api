import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req) => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const { searchParams } = new URL(req.url);
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = colaboradorResult.rows[0];

      // Chave de cache
      const cacheKey = `${CACHE_KEYS.BANCO_HORAS}${colaboradorId}:${dataInicio || 'all'}:${dataFim || 'all'}`;

      const dados = await cacheAside(cacheKey, async () => {
        // Construir filtros de data
        let dateFilter = '';
        const params_query: unknown[] = [colaboradorId];
        
        if (dataInicio && dataFim) {
          dateFilter = 'AND data >= $2 AND data <= $3';
          params_query.push(dataInicio, dataFim);
        }

        // Buscar resumo do banco de horas
        const resumoResult = await query(
          `SELECT 
            SUM(CASE WHEN tipo IN ('credito', 'ajuste') AND horas > 0 THEN horas ELSE 0 END) as horas_extras,
            SUM(CASE WHEN tipo IN ('debito', 'ajuste') AND horas < 0 THEN ABS(horas) ELSE 0 END) as horas_devidas,
            SUM(CASE WHEN tipo = 'compensacao' THEN ABS(horas) ELSE 0 END) as horas_compensadas
          FROM banco_horas
          WHERE colaborador_id = $1 ${dateFilter}`,
          params_query
        );

        // Buscar saldo atual
        const saldoResult = await query(
          `SELECT saldo_atual FROM banco_horas
           WHERE colaborador_id = $1
           ORDER BY criado_em DESC
           LIMIT 1`,
          [colaboradorId]
        );

        const resumo = resumoResult.rows[0];
        const saldoAtual = saldoResult.rows.length > 0 ? parseFloat(saldoResult.rows[0].saldo_atual) : 0;

        return {
          colaborador: {
            id: colaborador.id,
            nome: colaborador.nome,
          },
          periodo: {
            inicio: dataInicio || null,
            fim: dataFim || null,
          },
          saldoAtual: {
            horas: Math.abs(saldoAtual),
            tipo: saldoAtual >= 0 ? 'credito' : 'debito',
          },
          horasExtras: parseFloat(resumo.horas_extras) || 0,
          horasDevidas: parseFloat(resumo.horas_devidas) || 0,
          horasCompensadas: parseFloat(resumo.horas_compensadas) || 0,
        };
      }, CACHE_TTL.SHORT);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter banco de horas:', error);
      return serverErrorResponse('Erro ao obter banco de horas');
    }
  });
}
