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
          `SELECT id, telefone_rh, email_rh, dias_experiencia_padrao, dias_prorrogacao_padrao
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

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        result = await query(
          `UPDATE people.parametros_rh
           SET telefone_rh = COALESCE($1, telefone_rh),
               email_rh = COALESCE($2, email_rh),
               dias_experiencia_padrao = COALESCE($3, dias_experiencia_padrao),
               dias_prorrogacao_padrao = COALESCE($4, dias_prorrogacao_padrao),
               atualizado_em = CURRENT_TIMESTAMP,
               atualizado_por = $5
           WHERE id = $6
           RETURNING id, telefone_rh, email_rh, dias_experiencia_padrao, dias_prorrogacao_padrao`,
          [
            data.telefoneRh ?? null,
            data.emailRh ?? null,
            data.diasExperienciaPadrao ?? null,
            data.diasProrrogacaoPadrao ?? null,
            user.userId,
            parametroId,
          ]
        );
      } else {
        result = await query(
          `INSERT INTO people.parametros_rh (
             telefone_rh, email_rh, dias_experiencia_padrao, dias_prorrogacao_padrao, atualizado_por
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, telefone_rh, email_rh, dias_experiencia_padrao, dias_prorrogacao_padrao`,
          [
            data.telefoneRh ?? '',
            data.emailRh ?? '',
            data.diasExperienciaPadrao ?? 0,
            data.diasProrrogacaoPadrao ?? 0,
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
