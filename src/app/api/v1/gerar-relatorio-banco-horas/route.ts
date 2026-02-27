import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const colaboradorId = searchParams.get('colaboradorId');
      const departamentoId = searchParams.get('departamentoId');

      if (!dataInicio || !dataFim) {
        return errorResponse('Data início e fim são obrigatórias', 400);
      }

      // Construir filtros
      const conditions: string[] = ['bh.data >= $1', 'bh.data <= $2'];
      const params: unknown[] = [dataInicio, dataFim];
      let paramIndex = 3;

      if (colaboradorId) {
        conditions.push(`c.id = $${paramIndex}`);
        params.push(parseInt(colaboradorId));
        paramIndex++;
      }

      if (departamentoId) {
        conditions.push(`c.departamento_id = $${paramIndex}`);
        params.push(parseInt(departamentoId));
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Buscar dados agrupados por colaborador
      const result = await query(
        `SELECT 
          c.id,
          c.nome,
          d.nome as departamento,
          SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END) as horas_extras,
          SUM(CASE WHEN bh.horas < 0 THEN ABS(bh.horas) ELSE 0 END) as horas_devidas,
          (
            SELECT saldo_atual FROM bt_banco_horas 
            WHERE colaborador_id = c.id 
            ORDER BY criado_em DESC LIMIT 1
          ) as saldo_final
        FROM bluepoint.bt_colaboradores c
        LEFT JOIN bt_departamentos d ON c.departamento_id = d.id
        LEFT JOIN bt_banco_horas bh ON c.id = bh.colaborador_id
        ${whereClause}
        GROUP BY c.id, c.nome, d.nome
        HAVING COUNT(bh.id) > 0 OR $${paramIndex - 2}::int IS NOT NULL
        ORDER BY c.nome`,
        params
      );

      const colaboradores = result.rows.map(row => ({
        id: row.id,
        nome: row.nome,
        departamento: row.departamento,
        horasExtras: parseFloat(row.horas_extras) || 0,
        horasDevidas: parseFloat(row.horas_devidas) || 0,
        saldoFinal: parseFloat(row.saldo_final) || 0,
      }));

      // Calcular totalizadores
      const totalizadores = {
        totalHorasExtras: colaboradores.reduce((sum, c) => sum + c.horasExtras, 0),
        totalHorasDevidas: colaboradores.reduce((sum, c) => sum + c.horasDevidas, 0),
        saldoGeral: colaboradores.reduce((sum, c) => sum + c.saldoFinal, 0),
      };

      return successResponse({
        periodo: { inicio: dataInicio, fim: dataFim },
        colaboradores,
        totalizadores,
      });
    } catch (error) {
      console.error('Erro ao gerar relatório de banco de horas:', error);
      return serverErrorResponse('Erro ao gerar relatório');
    }
  });
}
