import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLimitesHeDepartamentosCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

// =====================================================
// DELETE - Remover limite de HE de um departamento
// =====================================================
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id: idStr } = await params;
      const id = parseInt(idStr);

      if (isNaN(id)) {
        return notFoundResponse('Limite não encontrado');
      }

      const result = await query(
        `DELETE FROM bluepoint.bt_limites_he_departamentos WHERE id = $1 RETURNING *`,
        [id]
      );

      if (result.rowCount === 0) {
        return notFoundResponse('Limite do departamento não encontrado');
      }

      await invalidateLimitesHeDepartamentosCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'limites_he_departamentos',
        descricao: `Limite de HE removido do departamento ID ${result.rows[0].departamento_id}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: result.rows[0],
      });

      return successResponse({ message: 'Limite do departamento removido com sucesso' });
    } catch (error) {
      console.error('Erro ao remover limite de HE do departamento:', error);
      return serverErrorResponse('Erro ao remover limite de horas extras do departamento');
    }
  });
}
