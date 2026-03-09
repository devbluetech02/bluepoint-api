import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const notificacaoId = parseInt(id);

      if (isNaN(notificacaoId)) {
        return notFoundResponse('Notificação não encontrada');
      }

      // Verificar se notificação existe e pertence ao usuário
      const result = await query(
        `SELECT id, lida FROM bt_notificacoes WHERE id = $1 AND usuario_id = $2`,
        [notificacaoId, user.userId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Notificação não encontrada');
      }

      if (result.rows[0].lida) {
        return errorResponse('Notificação já está marcada como lida', 400);
      }

      // Marcar como lida
      await query(
        `UPDATE bt_notificacoes SET lida = true, data_leitura = NOW() WHERE id = $1`,
        [notificacaoId]
      );

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'notificacoes',
        descricao: `Notificação #${notificacaoId} marcada como lida`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: notificacaoId, lida: false },
        dadosNovos: { id: notificacaoId, lida: true },
      });

      return successResponse({
        id: notificacaoId,
        lida: true,
        mensagem: 'Notificação marcada como lida',
      });
    } catch (error) {
      console.error('Erro ao marcar notificação:', error);
      return serverErrorResponse('Erro ao marcar notificação');
    }
  });
}
