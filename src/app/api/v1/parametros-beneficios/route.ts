import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { parametrosBeneficiosSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheAside, CACHE_KEYS, CACHE_TTL, invalidateParametrosBeneficiosCache } from '@/lib/cache';

const DEFAULTS = {
  valorValeTransporte: 17.5,
  valorValeAlimentacaoColaborador: 660,
  valorValeAlimentacaoSupervisor: 800,
  valorValeAlimentacaoCoordenador: 1000,
  horasMinimasParaValeAlimentacao: 6,
  diasUteisMes: 22,
};

// =====================================================
// GET /api/v1/parametros-beneficios
// Retorna os parâmetros de benefícios (VA/VT)
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.PARAMETROS_BENEFICIOS}atual`;

      const resultado = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT id, valor_vale_transporte, valor_vale_alimentacao_colaborador,
                  valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
                  horas_minimas_para_vale_alimentacao, dias_uteis_mes
           FROM bluepoint.bt_parametros_beneficios
           ORDER BY id DESC
           LIMIT 1`
        );

        if (result.rows.length === 0) {
          return DEFAULTS;
        }

        const row = result.rows[0];
        return {
          valorValeTransporte: Number(row.valor_vale_transporte),
          valorValeAlimentacaoColaborador: Number(row.valor_vale_alimentacao_colaborador),
          valorValeAlimentacaoSupervisor: Number(row.valor_vale_alimentacao_supervisor),
          valorValeAlimentacaoCoordenador: Number(row.valor_vale_alimentacao_coordenador),
          horasMinimasParaValeAlimentacao: Number(row.horas_minimas_para_vale_alimentacao),
          diasUteisMes: Number(row.dias_uteis_mes),
        };
      }, CACHE_TTL.LONG);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar parâmetros de benefícios:', error);
      return serverErrorResponse('Erro ao buscar parâmetros de benefícios');
    }
  });
}

// =====================================================
// PUT /api/v1/parametros-beneficios
// Cria ou atualiza os parâmetros de benefícios (VA/VT)
// =====================================================

export async function PUT(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(parametrosBeneficiosSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const existeResult = await query(
        `SELECT id FROM bluepoint.bt_parametros_beneficios ORDER BY id DESC LIMIT 1`
      );

      let result;
      const acao: 'CREATE' | 'UPDATE' = existeResult.rows.length > 0 ? 'UPDATE' : 'CREATE';

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        result = await query(
          `UPDATE bluepoint.bt_parametros_beneficios
           SET valor_vale_transporte = $1,
               valor_vale_alimentacao_colaborador = $2,
               valor_vale_alimentacao_supervisor = $3,
               valor_vale_alimentacao_coordenador = $4,
               horas_minimas_para_vale_alimentacao = $5,
               dias_uteis_mes = $6,
               atualizado_por = $7
           WHERE id = $8
           RETURNING id, valor_vale_transporte, valor_vale_alimentacao_colaborador,
                     valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
                     horas_minimas_para_vale_alimentacao, dias_uteis_mes`,
          [
            data.valorValeTransporte,
            data.valorValeAlimentacaoColaborador,
            data.valorValeAlimentacaoSupervisor,
            data.valorValeAlimentacaoCoordenador,
            data.horasMinimasParaValeAlimentacao,
            data.diasUteisMes,
            user.userId,
            parametroId,
          ]
        );
      } else {
        result = await query(
          `INSERT INTO bluepoint.bt_parametros_beneficios (
             valor_vale_transporte, valor_vale_alimentacao_colaborador,
             valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
             horas_minimas_para_vale_alimentacao, dias_uteis_mes, atualizado_por
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, valor_vale_transporte, valor_vale_alimentacao_colaborador,
                     valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
                     horas_minimas_para_vale_alimentacao, dias_uteis_mes`,
          [
            data.valorValeTransporte,
            data.valorValeAlimentacaoColaborador,
            data.valorValeAlimentacaoSupervisor,
            data.valorValeAlimentacaoCoordenador,
            data.horasMinimasParaValeAlimentacao,
            data.diasUteisMes,
            user.userId,
          ]
        );
      }

      const parametro = result.rows[0];
      const dataResponse = {
        valorValeTransporte: Number(parametro.valor_vale_transporte),
        valorValeAlimentacaoColaborador: Number(parametro.valor_vale_alimentacao_colaborador),
        valorValeAlimentacaoSupervisor: Number(parametro.valor_vale_alimentacao_supervisor),
        valorValeAlimentacaoCoordenador: Number(parametro.valor_vale_alimentacao_coordenador),
        horasMinimasParaValeAlimentacao: Number(parametro.horas_minimas_para_vale_alimentacao),
        diasUteisMes: Number(parametro.dias_uteis_mes),
      };

      await invalidateParametrosBeneficiosCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao,
        modulo: 'beneficios',
        descricao: `Parâmetros de benefícios (VA/VT) ${acao === 'CREATE' ? 'criados' : 'atualizados'}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: dataResponse,
      });

      return successResponse({
        ...dataResponse,
        mensagem: 'Parâmetros salvos com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar parâmetros de benefícios:', error);
      return serverErrorResponse('Erro ao atualizar parâmetros de benefícios');
    }
  });
}
