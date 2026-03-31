import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { parametrosHoraExtraSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheAside, CACHE_KEYS, CACHE_TTL, invalidateParametrosHoraExtraCache } from '@/lib/cache';

// =====================================================
// GET /api/v1/parametros-hora-extra
// Retorna os parâmetros de tolerância de hora extra
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.PARAMETROS_HORA_EXTRA}atual`;

      const resultado = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT p.id, p.minutos_tolerancia, p.dias_permitidos_por_mes, p.ativo,
                  p.atualizado_em, p.atualizado_por,
                  c.id AS usuario_id, c.nome AS usuario_nome
           FROM people.parametros_hora_extra p
           LEFT JOIN people.colaboradores c ON p.atualizado_por = c.id
           ORDER BY p.id DESC
           LIMIT 1`
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        return {
          id: row.id,
          minutosTolerancia: row.minutos_tolerancia,
          diasPermitidosPorMes: row.dias_permitidos_por_mes,
          ativo: row.ativo,
          atualizadoEm: row.atualizado_em,
          atualizadoPor: row.atualizado_por
            ? { id: row.usuario_id, nome: row.usuario_nome }
            : null,
        };
      }, CACHE_TTL.LONG);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar parâmetros de hora extra:', error);
      return serverErrorResponse('Erro ao buscar parâmetros de hora extra');
    }
  });
}

// =====================================================
// PUT /api/v1/parametros-hora-extra
// Cria ou atualiza os parâmetros de tolerância de hora extra
// =====================================================

export async function PUT(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(parametrosHoraExtraSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se já existe um registro de parâmetros
      const existeResult = await query(
        `SELECT id FROM people.parametros_hora_extra ORDER BY id DESC LIMIT 1`
      );

      let result;
      let acao: 'criar' | 'editar';

      if (existeResult.rows.length > 0) {
        // Atualizar registro existente
        const parametroId = existeResult.rows[0].id;
        acao = 'editar';

        result = await query(
          `UPDATE people.parametros_hora_extra
           SET minutos_tolerancia = $1,
               dias_permitidos_por_mes = $2,
               ativo = $3,
               atualizado_por = $4
           WHERE id = $5
           RETURNING id, minutos_tolerancia, dias_permitidos_por_mes, ativo, atualizado_em`,
          [data.minutosTolerancia, data.diasPermitidosPorMes, data.ativo, user.userId, parametroId]
        );
      } else {
        // Criar novo registro
        acao = 'criar';

        result = await query(
          `INSERT INTO people.parametros_hora_extra
             (minutos_tolerancia, dias_permitidos_por_mes, ativo, atualizado_por)
           VALUES ($1, $2, $3, $4)
           RETURNING id, minutos_tolerancia, dias_permitidos_por_mes, ativo, atualizado_em`,
          [data.minutosTolerancia, data.diasPermitidosPorMes, data.ativo, user.userId]
        );
      }

      const parametro = result.rows[0];

      // Invalidar cache
      await invalidateParametrosHoraExtraCache();

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao,
        modulo: 'horas_extras',
        descricao: `Parâmetros de hora extra ${acao === 'criar' ? 'criados' : 'atualizados'}: tolerância ${data.minutosTolerancia}min, ${data.diasPermitidosPorMes} dias/mês, ${data.ativo ? 'ativo' : 'inativo'}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          minutosTolerancia: data.minutosTolerancia,
          diasPermitidosPorMes: data.diasPermitidosPorMes,
          ativo: data.ativo,
        },
      });

      return successResponse(
        {
          id: parametro.id,
          minutosTolerancia: parametro.minutos_tolerancia,
          diasPermitidosPorMes: parametro.dias_permitidos_por_mes,
          ativo: parametro.ativo,
          atualizadoEm: parametro.atualizado_em,
          atualizadoPor: {
            id: user.userId,
            nome: user.nome,
          },
          mensagem: 'Parâmetros atualizados com sucesso',
        }
      );
    } catch (error) {
      console.error('Erro ao atualizar parâmetros de hora extra:', error);
      return serverErrorResponse('Erro ao atualizar parâmetros de hora extra');
    }
  });
}
