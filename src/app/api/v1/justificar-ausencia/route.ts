import { NextRequest } from 'next/server';
import { getClient, query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { justificarAusenciaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(justificarAusenciaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar anexo se informado
      if (data.anexoId) {
        const anexoResult = await query(
          `SELECT id FROM bt_anexos WHERE id = $1 AND colaborador_id = $2`,
          [data.anexoId, user.userId]
        );

        if (anexoResult.rows.length === 0) {
          return errorResponse('Anexo não encontrado', 404);
        }
      }

      await client.query('BEGIN');

      // Criar solicitação
      const result = await client.query(
        `INSERT INTO bt_solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'ausencia', $2, $3, $4, $5)
        RETURNING id`,
        [
          user.userId,
          data.data,
          data.motivo,
          data.justificativa,
          JSON.stringify({
            data: data.data,
            motivo: data.motivo,
          }),
        ]
      );

      const solicitacaoId = result.rows[0].id;

      // Vincular anexo se informado
      if (data.anexoId) {
        await client.query(
          `UPDATE bt_anexos SET solicitacao_id = $1 WHERE id = $2`,
          [solicitacaoId, data.anexoId]
        );
      }

      // Registrar histórico
      await client.query(
        `INSERT INTO bt_solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Justificativa de ausência criada')`,
        [solicitacaoId, user.userId]
      );

      await client.query('COMMIT');

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'solicitacoes',
        descricao: `Justificativa de ausência: ${data.motivo}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return createdResponse({
        solicitacaoId,
        status: 'pendente',
        mensagem: 'Justificativa de ausência enviada com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao justificar ausência:', error);
      return serverErrorResponse('Erro ao criar justificativa');
    } finally {
      client.release();
    }
  });
}
