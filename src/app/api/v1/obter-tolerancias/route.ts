import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const result = await query(
        `SELECT chave, valor FROM bt_configuracoes WHERE categoria = 'ponto'`
      );

      const config: Record<string, string> = {};
      for (const row of result.rows) {
        config[row.chave] = row.valor;
      }

      return successResponse({
        toleranciaEntrada: parseInt(config.tolerancia_entrada) || 10,
        toleranciaSaida: parseInt(config.tolerancia_saida) || 10,
        toleranciaIntervalo: parseInt(config.tolerancia_intervalo) || 5,
        considerarFimSemana: config.considerar_fim_semana === 'true',
        considerarFeriados: config.considerar_feriados !== 'false',
      });
    } catch (error) {
      console.error('Erro ao obter tolerâncias:', error);
      return serverErrorResponse('Erro ao obter tolerâncias');
    }
  });
}
