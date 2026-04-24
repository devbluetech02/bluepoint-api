import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { parametrosRhSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheAside, CACHE_KEYS, CACHE_TTL, invalidateParametrosRhCache } from '@/lib/cache';

const DEFAULTS = {
  telefoneRh: '',
  emailRh: '',
  diasExperienciaPadrao: 0,
  diasProrrogacaoPadrao: 0,
  diasUteisDataAdmissao: 2,
  vigenciaConfidencialidadeMeses: 24,
  aplicarBeneficiosEmDiaTeste: false,
};

// =====================================================
// GET /api/v1/parametros-rh
// Retorna os parâmetros globais de RH
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.PARAMETROS_RH}atual`;

      const resultado = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT id, telefone_rh, email_rh, dias_experiencia_padrao, dias_prorrogacao_padrao,
                  dias_uteis_data_admissao, vigencia_confidencialidade_meses,
                  aplicar_beneficios_em_dia_teste
           FROM people.parametros_rh
           ORDER BY id DESC
           LIMIT 1`
        );

        if (result.rows.length === 0) {
          return DEFAULTS;
        }

        const row = result.rows[0];
        return {
          telefoneRh: row.telefone_rh ?? '',
          emailRh: row.email_rh ?? '',
          diasExperienciaPadrao: Number(row.dias_experiencia_padrao ?? 0),
          diasProrrogacaoPadrao: Number(row.dias_prorrogacao_padrao ?? 0),
          diasUteisDataAdmissao: Number(row.dias_uteis_data_admissao ?? 2),
          vigenciaConfidencialidadeMeses: Number(row.vigencia_confidencialidade_meses ?? 24),
          aplicarBeneficiosEmDiaTeste: Boolean(row.aplicar_beneficios_em_dia_teste ?? false),
        };
      }, CACHE_TTL.LONG);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar parâmetros de RH:', error);
      return serverErrorResponse('Erro ao buscar parâmetros de RH');
    }
  });
}

// =====================================================
// PUT /api/v1/parametros-rh
// Cria ou atualiza os parâmetros globais de RH.
// Campos ausentes no body preservam o valor atual (UPDATE) ou usam default (INSERT).
// =====================================================

export async function PUT(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(parametrosRhSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const existeResult = await query(
        `SELECT id FROM people.parametros_rh ORDER BY id DESC LIMIT 1`
      );

      let result;
      const acao: 'criar' | 'editar' = existeResult.rows.length > 0 ? 'editar' : 'criar';

      const returningCols = `id, telefone_rh, email_rh, dias_experiencia_padrao, dias_prorrogacao_padrao,
        dias_uteis_data_admissao, vigencia_confidencialidade_meses, aplicar_beneficios_em_dia_teste`;

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        result = await query(
          `UPDATE people.parametros_rh
           SET telefone_rh = COALESCE($1, telefone_rh),
               email_rh = COALESCE($2, email_rh),
               dias_experiencia_padrao = COALESCE($3, dias_experiencia_padrao),
               dias_prorrogacao_padrao = COALESCE($4, dias_prorrogacao_padrao),
               dias_uteis_data_admissao = COALESCE($5, dias_uteis_data_admissao),
               vigencia_confidencialidade_meses = COALESCE($6, vigencia_confidencialidade_meses),
               aplicar_beneficios_em_dia_teste = COALESCE($7, aplicar_beneficios_em_dia_teste),
               atualizado_em = CURRENT_TIMESTAMP,
               atualizado_por = $8
           WHERE id = $9
           RETURNING ${returningCols}`,
          [
            data.telefoneRh ?? null,
            data.emailRh ?? null,
            data.diasExperienciaPadrao ?? null,
            data.diasProrrogacaoPadrao ?? null,
            data.diasUteisDataAdmissao ?? null,
            data.vigenciaConfidencialidadeMeses ?? null,
            data.aplicarBeneficiosEmDiaTeste ?? null,
            user.userId,
            parametroId,
          ]
        );
      } else {
        result = await query(
          `INSERT INTO people.parametros_rh (
             telefone_rh, email_rh,
             dias_experiencia_padrao, dias_prorrogacao_padrao,
             dias_uteis_data_admissao, vigencia_confidencialidade_meses,
             aplicar_beneficios_em_dia_teste,
             atualizado_por
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${returningCols}`,
          [
            data.telefoneRh ?? '',
            data.emailRh ?? '',
            data.diasExperienciaPadrao ?? 0,
            data.diasProrrogacaoPadrao ?? 0,
            data.diasUteisDataAdmissao ?? 2,
            data.vigenciaConfidencialidadeMeses ?? 24,
            data.aplicarBeneficiosEmDiaTeste ?? false,
            user.userId,
          ]
        );
      }

      const parametro = result.rows[0];
      const dataResponse = {
        telefoneRh: parametro.telefone_rh ?? '',
        emailRh: parametro.email_rh ?? '',
        diasExperienciaPadrao: Number(parametro.dias_experiencia_padrao ?? 0),
        diasProrrogacaoPadrao: Number(parametro.dias_prorrogacao_padrao ?? 0),
        diasUteisDataAdmissao: Number(parametro.dias_uteis_data_admissao ?? 2),
        vigenciaConfidencialidadeMeses: Number(parametro.vigencia_confidencialidade_meses ?? 24),
        aplicarBeneficiosEmDiaTeste: Boolean(parametro.aplicar_beneficios_em_dia_teste ?? false),
      };

      await invalidateParametrosRhCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao,
        modulo: 'configuracoes',
        descricao: `Parâmetros de RH ${acao === 'criar' ? 'criados' : 'atualizados'}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: dataResponse,
      });

      return successResponse({
        ...dataResponse,
        mensagem: 'Parâmetros de RH salvos com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar parâmetros de RH:', error);
      return serverErrorResponse('Erro ao atualizar parâmetros de RH');
    }
  });
}
