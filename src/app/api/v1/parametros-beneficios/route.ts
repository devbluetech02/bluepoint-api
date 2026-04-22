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
  descontoFaltaAlimentacao: 0,
  descontoFaltaCombustivel: 0,
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
                  horas_minimas_para_vale_alimentacao, dias_uteis_mes,
                  desconto_falta_alimentacao, desconto_falta_combustivel
           FROM people.parametros_beneficios
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
          descontoFaltaAlimentacao: Number(row.desconto_falta_alimentacao),
          descontoFaltaCombustivel: Number(row.desconto_falta_combustivel),
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
        `SELECT id FROM people.parametros_beneficios ORDER BY id DESC LIMIT 1`
      );

      let result;
      const acao: 'criar' | 'editar' = existeResult.rows.length > 0 ? 'editar' : 'criar';

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        result = await query(
          `UPDATE people.parametros_beneficios
           SET valor_vale_transporte = $1,
               valor_vale_alimentacao_colaborador = $2,
               valor_vale_alimentacao_supervisor = $3,
               valor_vale_alimentacao_coordenador = $4,
               horas_minimas_para_vale_alimentacao = $5,
               dias_uteis_mes = $6,
               desconto_falta_alimentacao = COALESCE($7, desconto_falta_alimentacao),
               desconto_falta_combustivel = COALESCE($8, desconto_falta_combustivel),
               atualizado_por = $9
           WHERE id = $10
           RETURNING id, valor_vale_transporte, valor_vale_alimentacao_colaborador,
                     valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
                     horas_minimas_para_vale_alimentacao, dias_uteis_mes,
                     desconto_falta_alimentacao, desconto_falta_combustivel`,
          [
            data.valorValeTransporte,
            data.valorValeAlimentacaoColaborador,
            data.valorValeAlimentacaoSupervisor,
            data.valorValeAlimentacaoCoordenador,
            data.horasMinimasParaValeAlimentacao,
            data.diasUteisMes,
            data.descontoFaltaAlimentacao ?? null,
            data.descontoFaltaCombustivel ?? null,
            user.userId,
            parametroId,
          ]
        );
      } else {
        result = await query(
          `INSERT INTO people.parametros_beneficios (
             valor_vale_transporte, valor_vale_alimentacao_colaborador,
             valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
             horas_minimas_para_vale_alimentacao, dias_uteis_mes,
             desconto_falta_alimentacao, desconto_falta_combustivel, atualizado_por
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, valor_vale_transporte, valor_vale_alimentacao_colaborador,
                     valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
                     horas_minimas_para_vale_alimentacao, dias_uteis_mes,
                     desconto_falta_alimentacao, desconto_falta_combustivel`,
          [
            data.valorValeTransporte,
            data.valorValeAlimentacaoColaborador,
            data.valorValeAlimentacaoSupervisor,
            data.valorValeAlimentacaoCoordenador,
            data.horasMinimasParaValeAlimentacao,
            data.diasUteisMes,
            data.descontoFaltaAlimentacao ?? 0,
            data.descontoFaltaCombustivel ?? 0,
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
        descontoFaltaAlimentacao: Number(parametro.desconto_falta_alimentacao),
        descontoFaltaCombustivel: Number(parametro.desconto_falta_combustivel),
      };

      await invalidateParametrosBeneficiosCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao,
        modulo: 'beneficios',
        descricao: `Parâmetros de benefícios (VA/VT) ${acao === 'criar' ? 'criados' : 'atualizados'}`,
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
