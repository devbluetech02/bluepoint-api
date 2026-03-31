import { NextRequest } from 'next/server';
import { getClient, query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atribuirJornadaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(atribuirJornadaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { jornadaId, colaboradorIds, dataInicio } = validation.data;

      // Verificar se jornada existe
      const jornadaResult = await query(
        `SELECT id, nome FROM people.jornadas WHERE id = $1 AND status = 'ativo'`,
        [jornadaId]
      );

      if (jornadaResult.rows.length === 0) {
        return errorResponse('Jornada não encontrada ou inativa', 404);
      }

      await client.query('BEGIN');

      let colaboradoresAtualizados = 0;

      for (const colaboradorId of colaboradorIds) {
        // Verificar se colaborador existe
        const colaboradorResult = await client.query(
          `SELECT id, jornada_id FROM people.colaboradores WHERE id = $1`,
          [colaboradorId]
        );

        if (colaboradorResult.rows.length === 0) {
          continue;
        }

        const colaborador = colaboradorResult.rows[0];

        // Se já tinha jornada, criar histórico
        if (colaborador.jornada_id) {
          await client.query(
            `UPDATE colaborador_jornadas_historico 
             SET data_fim = $1 
             WHERE colaborador_id = $2 AND data_fim IS NULL`,
            [dataInicio, colaboradorId]
          );
        }

        // Criar novo registro no histórico
        await client.query(
          `INSERT INTO colaborador_jornadas_historico (colaborador_id, jornada_id, data_inicio, criado_por)
           VALUES ($1, $2, $3, $4)`,
          [colaboradorId, jornadaId, dataInicio, user.userId]
        );

        // Atualizar colaborador
        await client.query(
          `UPDATE people.colaboradores SET jornada_id = $1, atualizado_em = NOW() WHERE id = $2`,
          [jornadaId, colaboradorId]
        );

        colaboradoresAtualizados++;
      }

      await client.query('COMMIT');

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'jornadas',
        descricao: `Jornada ${jornadaResult.rows[0].nome} atribuída a ${colaboradoresAtualizados} colaborador(es)`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          jornadaId,
          colaboradorIds,
          dataInicio,
          colaboradoresAtualizados,
        },
      });

      return successResponse({
        jornadaId,
        colaboradoresAtualizados,
        mensagem: `Jornada atribuída a ${colaboradoresAtualizados} colaborador(es)`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao atribuir jornada:', error);
      return serverErrorResponse('Erro ao atribuir jornada');
    } finally {
      client.release();
    }
  });
}
