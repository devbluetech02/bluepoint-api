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
  diasFeriasPadrao: 30,
  abonoPecuniarioPadrao: true,
  adiantamento13Padrao: true,
  // Migration 038 — Parâmetros de Recrutamento
  diasTestePadrao: 2,
  cargaHorariaTestePadrao: 8,
  valorDiariaTestePadrao: 10,
  percentualMinimoDecisao: 50,
};

const RETURNING_COLS = `id, telefone_rh, email_rh,
  dias_experiencia_padrao, dias_prorrogacao_padrao,
  dias_uteis_data_admissao, vigencia_confidencialidade_meses,
  aplicar_beneficios_em_dia_teste,
  dias_ferias_padrao, abono_pecuniario_padrao, adiantamento_13_padrao,
  dias_teste_padrao, carga_horaria_teste_padrao,
  valor_diaria_teste_padrao, percentual_minimo_decisao`;

type Row = {
  id: number;
  telefone_rh: string | null;
  email_rh: string | null;
  dias_experiencia_padrao: number | string | null;
  dias_prorrogacao_padrao: number | string | null;
  dias_uteis_data_admissao: number | string | null;
  vigencia_confidencialidade_meses: number | string | null;
  aplicar_beneficios_em_dia_teste: boolean | null;
  dias_ferias_padrao: number | string | null;
  abono_pecuniario_padrao: boolean | null;
  adiantamento_13_padrao: boolean | null;
  dias_teste_padrao: number | string | null;
  carga_horaria_teste_padrao: number | string | null;
  valor_diaria_teste_padrao: number | string | null;
  percentual_minimo_decisao: number | string | null;
};

function mapRow(row: Row) {
  return {
    telefoneRh: row.telefone_rh ?? '',
    emailRh: row.email_rh ?? '',
    diasExperienciaPadrao: Number(row.dias_experiencia_padrao ?? 0),
    diasProrrogacaoPadrao: Number(row.dias_prorrogacao_padrao ?? 0),
    diasUteisDataAdmissao: Number(row.dias_uteis_data_admissao ?? 2),
    vigenciaConfidencialidadeMeses: Number(row.vigencia_confidencialidade_meses ?? 24),
    aplicarBeneficiosEmDiaTeste: Boolean(row.aplicar_beneficios_em_dia_teste ?? false),
    diasFeriasPadrao: Number(row.dias_ferias_padrao ?? 30),
    abonoPecuniarioPadrao: Boolean(row.abono_pecuniario_padrao ?? true),
    adiantamento13Padrao: Boolean(row.adiantamento_13_padrao ?? true),
    diasTestePadrao: Number(row.dias_teste_padrao ?? 2),
    cargaHorariaTestePadrao: Number(row.carga_horaria_teste_padrao ?? 8),
    valorDiariaTestePadrao: Number(row.valor_diaria_teste_padrao ?? 10),
    percentualMinimoDecisao: Number(row.percentual_minimo_decisao ?? 50),
  };
}

// =====================================================
// GET /api/v1/parametros-rh
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.PARAMETROS_RH}atual`;

      const resultado = await cacheAside(cacheKey, async () => {
        const result = await query<Row>(
          `SELECT ${RETURNING_COLS}
           FROM people.parametros_rh
           ORDER BY id DESC
           LIMIT 1`
        );

        if (result.rows.length === 0) return DEFAULTS;
        return mapRow(result.rows[0]);
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

      const existeResult = await query<{ id: number }>(
        `SELECT id FROM people.parametros_rh ORDER BY id DESC LIMIT 1`
      );

      let result;
      const acao: 'criar' | 'editar' = existeResult.rows.length > 0 ? 'editar' : 'criar';

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        result = await query<Row>(
          `UPDATE people.parametros_rh
           SET telefone_rh = COALESCE($1, telefone_rh),
               email_rh = COALESCE($2, email_rh),
               dias_experiencia_padrao = COALESCE($3, dias_experiencia_padrao),
               dias_prorrogacao_padrao = COALESCE($4, dias_prorrogacao_padrao),
               dias_uteis_data_admissao = COALESCE($5, dias_uteis_data_admissao),
               vigencia_confidencialidade_meses = COALESCE($6, vigencia_confidencialidade_meses),
               aplicar_beneficios_em_dia_teste = COALESCE($7, aplicar_beneficios_em_dia_teste),
               dias_ferias_padrao = COALESCE($8, dias_ferias_padrao),
               abono_pecuniario_padrao = COALESCE($9, abono_pecuniario_padrao),
               adiantamento_13_padrao = COALESCE($10, adiantamento_13_padrao),
               dias_teste_padrao = COALESCE($11, dias_teste_padrao),
               carga_horaria_teste_padrao = COALESCE($12, carga_horaria_teste_padrao),
               valor_diaria_teste_padrao = COALESCE($13, valor_diaria_teste_padrao),
               percentual_minimo_decisao = COALESCE($14, percentual_minimo_decisao),
               atualizado_em = CURRENT_TIMESTAMP,
               atualizado_por = $15
           WHERE id = $16
           RETURNING ${RETURNING_COLS}`,
          [
            data.telefoneRh ?? null,
            data.emailRh ?? null,
            data.diasExperienciaPadrao ?? null,
            data.diasProrrogacaoPadrao ?? null,
            data.diasUteisDataAdmissao ?? null,
            data.vigenciaConfidencialidadeMeses ?? null,
            data.aplicarBeneficiosEmDiaTeste ?? null,
            data.diasFeriasPadrao ?? null,
            data.abonoPecuniarioPadrao ?? null,
            data.adiantamento13Padrao ?? null,
            data.diasTestePadrao ?? null,
            data.cargaHorariaTestePadrao ?? null,
            data.valorDiariaTestePadrao ?? null,
            data.percentualMinimoDecisao ?? null,
            user.userId,
            parametroId,
          ]
        );
      } else {
        result = await query<Row>(
          `INSERT INTO people.parametros_rh (
             telefone_rh, email_rh,
             dias_experiencia_padrao, dias_prorrogacao_padrao,
             dias_uteis_data_admissao, vigencia_confidencialidade_meses,
             aplicar_beneficios_em_dia_teste,
             dias_ferias_padrao, abono_pecuniario_padrao, adiantamento_13_padrao,
             dias_teste_padrao, carga_horaria_teste_padrao,
             valor_diaria_teste_padrao, percentual_minimo_decisao,
             atualizado_por
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING ${RETURNING_COLS}`,
          [
            data.telefoneRh ?? '',
            data.emailRh ?? '',
            data.diasExperienciaPadrao ?? 0,
            data.diasProrrogacaoPadrao ?? 0,
            data.diasUteisDataAdmissao ?? 2,
            data.vigenciaConfidencialidadeMeses ?? 24,
            data.aplicarBeneficiosEmDiaTeste ?? false,
            data.diasFeriasPadrao ?? 30,
            data.abonoPecuniarioPadrao ?? true,
            data.adiantamento13Padrao ?? true,
            data.diasTestePadrao ?? 2,
            data.cargaHorariaTestePadrao ?? 8,
            data.valorDiariaTestePadrao ?? 10,
            data.percentualMinimoDecisao ?? 50,
            user.userId,
          ]
        );
      }

      const dataResponse = mapRow(result.rows[0]);

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
