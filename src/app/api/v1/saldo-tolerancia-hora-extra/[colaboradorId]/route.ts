import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// =====================================================
// GET /api/v1/saldo-tolerancia-hora-extra/[colaboradorId]?mes=2026-02
// Retorna o saldo de tolerância de hora extra de um colaborador
// =====================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ colaboradorId: string }> }
) {
  return withAuth(request, async (req) => {
    try {
      const { colaboradorId: colaboradorIdStr } = await params;
      const colaboradorId = parseInt(colaboradorIdStr);

      if (isNaN(colaboradorId) || colaboradorId <= 0) {
        return errorResponse('ID do colaborador inválido', 400);
      }

      const { searchParams } = new URL(req.url);
      const mesParam = searchParams.get('mes');

      // Validar formato do mês (YYYY-MM)
      if (mesParam && !/^\d{4}-\d{2}$/.test(mesParam)) {
        return errorResponse('Parâmetro "mes" deve estar no formato YYYY-MM', 400);
      }

      // Se não informado, usar mês atual
      const mes = mesParam || new Date().toISOString().substring(0, 7);
      const [ano, mesNum] = mes.split('-').map(Number);

      // Calcular primeiro e último dia do mês
      const primeiroDia = `${mes}-01`;
      const ultimoDia = new Date(ano, mesNum, 0).toISOString().split('T')[0];

      // Chave de cache
      const cacheKey = `${CACHE_KEYS.TOLERANCIA_HORA_EXTRA}${colaboradorId}:${mes}`;

      const resultado = await cacheAside(cacheKey, async () => {
        // Verificar se colaborador existe
        const colaboradorResult = await query(
          `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo'`,
          [colaboradorId]
        );

        if (colaboradorResult.rows.length === 0) {
          return { error: 'Colaborador não encontrado ou inativo', status: 404 };
        }

        // Buscar parâmetros ativos
        const parametroResult = await query(
          `SELECT id, minutos_tolerancia, dias_permitidos_por_mes, ativo
           FROM people.parametros_hora_extra
           WHERE ativo = TRUE
           ORDER BY id DESC
           LIMIT 1`
        );

        if (parametroResult.rows.length === 0) {
          return {
            colaboradorId,
            mes,
            parametro: null,
            diasUtilizados: 0,
            diasRestantes: 0,
            historico: [],
          };
        }

        const parametro = parametroResult.rows[0];

        // Buscar histórico de tolerância do colaborador no mês
        const historicoResult = await query(
          `SELECT data::text AS data, minutos_hora_extra, consumiu_tolerancia
           FROM people.historico_tolerancia_hora_extra
           WHERE colaborador_id = $1
             AND data BETWEEN $2::date AND $3::date
             AND consumiu_tolerancia = TRUE
           ORDER BY data ASC`,
          [colaboradorId, primeiroDia, ultimoDia]
        );

        const diasUtilizados = historicoResult.rows.length;
        const diasRestantes = Math.max(0, parametro.dias_permitidos_por_mes - diasUtilizados);

        const historico = historicoResult.rows.map((row) => ({
          data: row.data,
          minutosHoraExtra: row.minutos_hora_extra,
          consumiuTolerancia: row.consumiu_tolerancia,
        }));

        return {
          colaboradorId,
          mes,
          parametro: {
            minutosTolerancia: parametro.minutos_tolerancia,
            diasPermitidosPorMes: parametro.dias_permitidos_por_mes,
          },
          diasUtilizados,
          diasRestantes,
          historico,
        };
      }, CACHE_TTL.SHORT);

      // Verificar se retornou erro (colaborador não encontrado)
      if (resultado && 'error' in resultado && 'status' in resultado) {
        return errorResponse(resultado.error as string, resultado.status as number);
      }

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar saldo de tolerância de hora extra:', error);
      return serverErrorResponse('Erro ao buscar saldo de tolerância de hora extra');
    }
  });
}
