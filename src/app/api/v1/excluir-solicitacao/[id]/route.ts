import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      // Verificar se solicitação existe
      const solicitacaoResult = await query(
        `SELECT * FROM bt_solicitacoes WHERE id = $1`,
        [solicitacaoId]
      );

      if (solicitacaoResult.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const solicitacao = solicitacaoResult.rows[0];

      // Verificar se pode ser cancelada
      if (solicitacao.status !== 'pendente') {
        return errorResponse('Apenas solicitações pendentes podem ser canceladas', 400);
      }

      // Verificar permissão
      if (solicitacao.colaborador_id !== user.userId && user.tipo === 'colaborador') {
        return errorResponse('Você só pode cancelar suas próprias solicitações', 403);
      }

      // Atualizar status para cancelada
      await query(
        `UPDATE bt_solicitacoes SET status = 'cancelada', atualizado_em = NOW() WHERE id = $1`,
        [solicitacaoId]
      );

      // Registrar histórico
      await query(
        `INSERT INTO bt_solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', 'cancelada', $2, 'Solicitação cancelada')`,
        [solicitacaoId, user.userId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'solicitacoes',
        descricao: `Solicitação cancelada: ${solicitacao.tipo}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir solicitação:', error);
      return serverErrorResponse('Erro ao excluir solicitação');
    }
  });
}
