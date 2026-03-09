import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLiderancasDepartamentoCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

// =====================================================
// DELETE - Remover configuração de liderança de um departamento
// =====================================================
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id: idStr } = await params;
      const id = parseInt(idStr);

      if (isNaN(id)) {
        return notFoundResponse('Liderança não encontrada');
      }

      const result = await query(
        `DELETE FROM bluepoint.bt_liderancas_departamento WHERE id = $1 RETURNING *`,
        [id]
      );

      if (result.rowCount === 0) {
        return notFoundResponse('Liderança não encontrada');
      }

      await invalidateLiderancasDepartamentoCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'liderancas_departamento',
        descricao: `Liderança removida do departamento ID ${result.rows[0].departamento_id}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: result.rows[0],
      });

      return successResponse({ message: 'Liderança removida com sucesso' });
    } catch (error) {
      console.error('Erro ao remover liderança de departamento:', error);
      return serverErrorResponse('Erro ao remover liderança de departamento');
    }
  });
}
