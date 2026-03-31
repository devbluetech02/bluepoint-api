import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const localizacaoId = parseInt(id);

      if (isNaN(localizacaoId)) {
        return notFoundResponse('Localização não encontrada');
      }

      const result = await query(
        `SELECT id, nome FROM localizacoes WHERE id = $1`,
        [localizacaoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Localização não encontrada');
      }

      const localizacao = result.rows[0];

      // Soft delete
      await query(
        `UPDATE localizacoes SET status = 'inativo', atualizado_em = NOW() WHERE id = $1`,
        [localizacaoId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'localizacoes',
        descricao: `Localização excluída: ${localizacao.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir localização:', error);
      return serverErrorResponse('Erro ao excluir localização');
    }
  });
}
