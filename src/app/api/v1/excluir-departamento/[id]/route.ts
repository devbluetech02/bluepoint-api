import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const departamentoId = parseInt(id);

      if (isNaN(departamentoId)) {
        return notFoundResponse('Departamento não encontrado');
      }

      // Verificar se existe
      const result = await query(
        `SELECT id, nome FROM bt_departamentos WHERE id = $1`,
        [departamentoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Departamento não encontrado');
      }

      const departamento = result.rows[0];

      // Verificar se há colaboradores vinculados
      const colaboradoresResult = await query(
        `SELECT COUNT(*) as total FROM bluepoint.bt_colaboradores WHERE departamento_id = $1`,
        [departamentoId]
      );

      if (parseInt(colaboradoresResult.rows[0].total) > 0) {
        return errorResponse('Não é possível excluir departamento com colaboradores vinculados', 400);
      }

      // Soft delete
      await query(
        `UPDATE bt_departamentos SET status = 'inativo', atualizado_em = NOW() WHERE id = $1`,
        [departamentoId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'departamentos',
        descricao: `Departamento excluído: ${departamento.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir departamento:', error);
      return serverErrorResponse('Erro ao excluir departamento');
    }
  });
}
