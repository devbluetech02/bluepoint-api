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
      const jornadaId = parseInt(id);

      if (isNaN(jornadaId)) {
        return notFoundResponse('Jornada não encontrada');
      }

      // Verificar se jornada existe
      const jornadaResult = await query(
        `SELECT id, nome FROM people.jornadas WHERE id = $1`,
        [jornadaId]
      );

      if (jornadaResult.rows.length === 0) {
        return notFoundResponse('Jornada não encontrada');
      }

      const jornada = jornadaResult.rows[0];

      // Verificar se há colaboradores vinculados
      const colaboradoresResult = await query(
        `SELECT COUNT(*) as total FROM people.colaboradores WHERE jornada_id = $1`,
        [jornadaId]
      );

      if (parseInt(colaboradoresResult.rows[0].total) > 0) {
        return errorResponse('Não é possível excluir jornada com colaboradores vinculados', 400);
      }

      // Soft delete - marca como inativo e preenche data de exclusão
      await query(
        `UPDATE people.jornadas SET status = 'inativo', excluido_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
        [jornadaId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'jornadas',
        descricao: `Jornada excluída: ${jornada.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: jornadaId, nome: jornada.nome },
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir jornada:', error);
      return serverErrorResponse('Erro ao excluir jornada');
    }
  });
}
