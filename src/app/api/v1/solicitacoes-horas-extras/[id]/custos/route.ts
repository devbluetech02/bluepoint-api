import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { calcularCustoHoraExtra, salvarCustoHoraExtra } from '@/lib/custoHorasExtrasService';

interface Params {
  params: Promise<{ id: string }>;
}

function parseCustoRow(row: Record<string, string>) {
  return {
    horas_extras: parseFloat(row.horas_extras),
    valor_he_base: parseFloat(row.valor_he_base),
    valor_dsr: parseFloat(row.valor_dsr),
    valor_13: parseFloat(row.valor_13),
    valor_ferias: parseFloat(row.valor_ferias),
    um_terco_ferias: parseFloat(row.um_terco_ferias),
    valor_fgts: parseFloat(row.valor_fgts),
    valor_inss: parseFloat(row.valor_inss),
    custo_dia: parseFloat(row.custo_dia),
    custo_mes: parseFloat(row.custo_mes),
    custo_ano: parseFloat(row.custo_ano),
  };
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.CUSTO_HORAS_EXTRAS}${solicitacaoId}`;

      const custos = await cacheAside(cacheKey, async () => {
        // 1. Buscar custos pré-calculados (tabela bt_custo_horas_extras)
        const result = await query(
          `SELECT horas_extras, valor_he_base, valor_dsr, valor_13, valor_ferias,
                  um_terco_ferias, valor_fgts, valor_inss, custo_dia, custo_mes, custo_ano
           FROM bluepoint.bt_custo_horas_extras
           WHERE solicitacao_id = $1 OR solicitacao_original_id = $1
           LIMIT 1`,
          [solicitacaoId]
        );

        if (result.rows.length > 0) {
          return parseCustoRow(result.rows[0]);
        }

        // 2. Fallback: calcular a partir de bt_solicitacoes (sistema geral)
        const solResult = await query(
          `SELECT colaborador_id, dados_adicionais FROM bluepoint.bt_solicitacoes
           WHERE id = $1 AND tipo = 'hora_extra'`,
          [solicitacaoId]
        );

        if (solResult.rows.length === 0) return null;

        const sol = solResult.rows[0];
        const dados = sol.dados_adicionais;
        if (!dados?.horaInicio || !dados?.horaFim || !sol.colaborador_id) return null;

        const calculated = await calcularCustoHoraExtra(
          sol.colaborador_id,
          dados.horaInicio,
          dados.horaFim
        );
        if (!calculated) return null;

        // Persistir para não recalcular na próxima vez
        try {
          await salvarCustoHoraExtra(
            solicitacaoId,
            sol.colaborador_id,
            calculated.cargo_id,
            calculated.empresa_id,
            calculated
          );
        } catch {
          // ignore duplicate/constraint errors
        }

        return {
          horas_extras: calculated.horas_extras,
          valor_he_base: calculated.valor_he_base,
          valor_dsr: calculated.valor_dsr,
          valor_13: calculated.valor_13,
          valor_ferias: calculated.valor_ferias,
          um_terco_ferias: calculated.um_terco_ferias,
          valor_fgts: calculated.valor_fgts,
          valor_inss: calculated.valor_inss,
          custo_dia: calculated.custo_dia,
          custo_mes: calculated.custo_mes,
          custo_ano: calculated.custo_ano,
        };
      }, CACHE_TTL.MEDIUM);

      if (!custos) {
        return notFoundResponse('Custos não encontrados para esta solicitação');
      }

      return successResponse(custos);
    } catch (error) {
      console.error('Erro ao buscar custos da solicitação:', error);
      return serverErrorResponse('Erro ao buscar custos da solicitação');
    }
  });
}
