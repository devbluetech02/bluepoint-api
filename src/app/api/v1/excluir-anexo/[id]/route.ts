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
      const anexoId = parseInt(id);

      if (isNaN(anexoId)) {
        return notFoundResponse('Anexo não encontrado');
      }

      // Verificar se anexo existe e pertence ao usuário
      const result = await query(
        `SELECT * FROM bt_anexos WHERE id = $1`,
        [anexoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Anexo não encontrado');
      }

      const anexo = result.rows[0];

      // Verificar permissão
      if (anexo.colaborador_id !== user.userId && user.tipo === 'colaborador') {
        return errorResponse('Sem permissão para excluir este anexo', 403);
      }

      // Verificar se está vinculado a solicitação aprovada/rejeitada
      if (anexo.solicitacao_id) {
        const solicitacaoResult = await query(
          `SELECT status FROM bt_solicitacoes WHERE id = $1`,
          [anexo.solicitacao_id]
        );
        
        if (solicitacaoResult.rows.length > 0 && solicitacaoResult.rows[0].status !== 'pendente') {
          return errorResponse('Não é possível excluir anexo de solicitação já processada', 400);
        }
      }

      // Excluir do banco (o arquivo no MinIO pode ser mantido por questões de auditoria)
      await query(`DELETE FROM bt_anexos WHERE id = $1`, [anexoId]);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'anexos',
        descricao: `Anexo #${anexoId} excluído (${anexo.nome || 'sem nome'})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: anexo.id, nome: anexo.nome, tipo: anexo.tipo, url: anexo.url, solicitacao_id: anexo.solicitacao_id },
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir anexo:', error);
      return serverErrorResponse('Erro ao excluir anexo');
    }
  });
}
