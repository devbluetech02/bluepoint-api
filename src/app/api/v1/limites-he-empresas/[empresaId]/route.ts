import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLimitesHeEmpresasCache } from '@/lib/cache';

interface Params {
  params: Promise<{ empresaId: string }>;
}

// =====================================================
// DELETE - Remover limite de HE de uma empresa
// =====================================================
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { empresaId: empresaIdStr } = await params;
      const empresaId = parseInt(empresaIdStr);

      if (isNaN(empresaId)) {
        return notFoundResponse('Empresa não encontrada');
      }

      const result = await query(
        `DELETE FROM bluepoint.bt_limites_he_empresas WHERE empresa_id = $1 RETURNING *`,
        [empresaId]
      );

      if (result.rowCount === 0) {
        return notFoundResponse('Limite não encontrado para esta empresa');
      }

      await invalidateLimitesHeEmpresasCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'limites_he_empresas',
        descricao: `Limite de HE removido da empresa ID ${empresaId}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { empresa_id: empresaId },
      });

      return successResponse({ message: 'Limite removido com sucesso' });
    } catch (error) {
      console.error('Erro ao remover limite de HE da empresa:', error);
      return serverErrorResponse('Erro ao remover limite de horas extras da empresa');
    }
  });
}
