import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { atualizarSolicitacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarSolicitacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se solicitação existe e pertence ao usuário
      const solicitacaoResult = await query(
        `SELECT * FROM bt_solicitacoes WHERE id = $1`,
        [solicitacaoId]
      );

      if (solicitacaoResult.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const solicitacao = solicitacaoResult.rows[0];

      // Verificar se pode ser atualizada
      if (solicitacao.status !== 'pendente') {
        return errorResponse('Apenas solicitações pendentes podem ser atualizadas', 400);
      }

      if (solicitacao.colaborador_id !== user.userId) {
        return errorResponse('Você só pode atualizar suas próprias solicitações', 403);
      }

      // Atualizar
      await query(
        `UPDATE bt_solicitacoes SET
          data_evento = COALESCE($1, data_evento),
          descricao = COALESCE($2, descricao),
          justificativa = COALESCE($3, justificativa),
          dados_adicionais = COALESCE($4, dados_adicionais),
          atualizado_em = NOW()
        WHERE id = $5`,
        [
          data.dataEvento,
          data.descricao,
          data.justificativa,
          data.dadosAdicionais ? JSON.stringify(data.dadosAdicionais) : null,
          solicitacaoId,
        ]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'solicitacoes',
        descricao: `Solicitação atualizada: ${solicitacao.tipo}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return successResponse({
        id: solicitacaoId,
        mensagem: 'Solicitação atualizada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar solicitação:', error);
      return serverErrorResponse('Erro ao atualizar solicitação');
    }
  });
}
