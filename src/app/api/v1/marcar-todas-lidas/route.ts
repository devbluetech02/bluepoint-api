import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function PATCH(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const result = await query(
        `UPDATE bt_notificacoes 
         SET lida = true, data_leitura = NOW() 
         WHERE usuario_id = $1 AND lida = false
         RETURNING id`,
        [user.userId]
      );

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'notificacoes',
        descricao: `${result.rowCount} notificação(ões) marcada(s) como lida(s)`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { notificacoesMarcadas: result.rowCount },
      });

      return successResponse({
        notificacoesMarcadas: result.rowCount,
        mensagem: `${result.rowCount} notificação(ões) marcada(s) como lida(s)`,
      });
    } catch (error) {
      console.error('Erro ao marcar notificações:', error);
      return serverErrorResponse('Erro ao marcar notificações');
    }
  });
}
