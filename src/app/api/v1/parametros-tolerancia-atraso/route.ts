import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { parametrosToleranciaAtrasoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheAside, CACHE_KEYS, CACHE_TTL, cacheDelPattern } from '@/lib/cache';

// =====================================================
// GET /api/v1/parametros-tolerancia-atraso
// Retorna os parâmetros globais de tolerância de atraso
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.PARAMETROS_TOLERANCIA_ATRASO}atual`;

      const resultado = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT p.id, p.tolerancia_periodo_min, p.tolerancia_diario_max_min, p.ativo,
                  p.atualizado_em, p.atualizado_por,
                  c.id AS usuario_id, c.nome AS usuario_nome
           FROM bluepoint.bt_parametros_tolerancia_atraso p
           LEFT JOIN bluepoint.bt_colaboradores c ON p.atualizado_por = c.id
           ORDER BY p.id DESC
           LIMIT 1`
        );

        if (result.rows.length === 0) {
          return {
            id: null,
            toleranciaPeriodoMin: 10,
            toleranciaDiarioMaxMin: 10,
            ativo: true,
            atualizadoEm: null,
            atualizadoPor: null,
          };
        }

        const row = result.rows[0];

        return {
          id: row.id,
          toleranciaPeriodoMin: row.tolerancia_periodo_min,
          toleranciaDiarioMaxMin: row.tolerancia_diario_max_min,
          ativo: row.ativo,
          atualizadoEm: row.atualizado_em,
          atualizadoPor: row.atualizado_por
            ? { id: row.usuario_id, nome: row.usuario_nome }
            : null,
        };
      }, CACHE_TTL.LONG);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar parâmetros de tolerância de atraso:', error);
      return serverErrorResponse('Erro ao buscar parâmetros de tolerância de atraso');
    }
  });
}

// =====================================================
// PUT /api/v1/parametros-tolerancia-atraso
// Cria ou atualiza os parâmetros globais de tolerância de atraso
// =====================================================

export async function PUT(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(parametrosToleranciaAtrasoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const existeResult = await query(
        `SELECT id FROM bluepoint.bt_parametros_tolerancia_atraso ORDER BY id DESC LIMIT 1`
      );

      let result;
      let acao: 'CREATE' | 'UPDATE';

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        acao = 'UPDATE';

        result = await query(
          `UPDATE bluepoint.bt_parametros_tolerancia_atraso
           SET tolerancia_periodo_min = $1,
               tolerancia_diario_max_min = $2,
               ativo = $3,
               atualizado_por = $4
           WHERE id = $5
           RETURNING id, tolerancia_periodo_min, tolerancia_diario_max_min, ativo, atualizado_em`,
          [data.toleranciaPeriodoMin, data.toleranciaDiarioMaxMin, data.ativo, user.userId, parametroId]
        );
      } else {
        acao = 'CREATE';

        result = await query(
          `INSERT INTO bluepoint.bt_parametros_tolerancia_atraso
             (tolerancia_periodo_min, tolerancia_diario_max_min, ativo, atualizado_por)
           VALUES ($1, $2, $3, $4)
           RETURNING id, tolerancia_periodo_min, tolerancia_diario_max_min, ativo, atualizado_em`,
          [data.toleranciaPeriodoMin, data.toleranciaDiarioMaxMin, data.ativo, user.userId]
        );
      }

      const parametro = result.rows[0];

      // Invalidar cache
      await cacheDelPattern(`${CACHE_KEYS.PARAMETROS_TOLERANCIA_ATRASO}*`);
      await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao,
        modulo: 'registro_ponto',
        descricao: `Parâmetros de tolerância de atraso ${acao === 'CREATE' ? 'criados' : 'atualizados'}: período ${data.toleranciaPeriodoMin}min, diário ${data.toleranciaDiarioMaxMin}min, ${data.ativo ? 'ativo' : 'inativo'}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          toleranciaPeriodoMin: data.toleranciaPeriodoMin,
          toleranciaDiarioMaxMin: data.toleranciaDiarioMaxMin,
          ativo: data.ativo,
        },
      });

      return successResponse({
        id: parametro.id,
        toleranciaPeriodoMin: parametro.tolerancia_periodo_min,
        toleranciaDiarioMaxMin: parametro.tolerancia_diario_max_min,
        ativo: parametro.ativo,
        atualizadoEm: parametro.atualizado_em,
        atualizadoPor: {
          id: user.userId,
          nome: user.nome,
        },
        mensagem: 'Parâmetros de tolerância de atraso atualizados com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar parâmetros de tolerância de atraso:', error);
      return serverErrorResponse('Erro ao atualizar parâmetros de tolerância de atraso');
    }
  });
}
