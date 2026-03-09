import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const empresaId = parseInt(id);

      if (isNaN(empresaId)) {
        return notFoundResponse('Empresa não encontrada');
      }

      // Verificar se empresa existe
      const empresaAtual = await query(
        `SELECT * FROM bluepoint.bt_empresas WHERE id = $1`,
        [empresaId]
      );

      if (empresaAtual.rows.length === 0) {
        return notFoundResponse('Empresa não encontrada');
      }

      const dadosAnteriores = empresaAtual.rows[0];

      // Excluir empresa
      await query(
        `DELETE FROM bluepoint.bt_empresas WHERE id = $1`,
        [empresaId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'empresas',
        descricao: `Empresa excluída: ${dadosAnteriores.fantasia}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: dadosAnteriores.id, fantasia: dadosAnteriores.fantasia, cnpj: dadosAnteriores.cnpj },
      });

      return successResponse({
        mensagem: 'Empresa excluída com sucesso',
      });
    } catch (error) {
      console.error('Erro ao excluir empresa:', error);
      return serverErrorResponse('Erro ao excluir empresa');
    }
  });
}
