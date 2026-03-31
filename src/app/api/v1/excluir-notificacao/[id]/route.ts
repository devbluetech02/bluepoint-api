import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const notificacaoId = parseInt(id);

      if (isNaN(notificacaoId)) {
        return notFoundResponse('Notificação não encontrada');
      }

      // Verificar se notificação existe e pertence ao usuário
      const result = await query(
        `SELECT id FROM notificacoes WHERE id = $1 AND usuario_id = $2`,
        [notificacaoId, user.userId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Notificação não encontrada');
      }

      // Excluir
      await query(`DELETE FROM notificacoes WHERE id = $1`, [notificacaoId]);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'notificacoes',
        descricao: `Notificação #${notificacaoId} excluída`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: notificacaoId },
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir notificação:', error);
      return serverErrorResponse('Erro ao excluir notificação');
    }
  });
}
