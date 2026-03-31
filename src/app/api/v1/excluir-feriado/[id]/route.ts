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
      const feriadoId = parseInt(id);

      if (isNaN(feriadoId)) {
        return notFoundResponse('Feriado não encontrado');
      }

      const result = await query(
        `SELECT id, nome FROM feriados WHERE id = $1`,
        [feriadoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Feriado não encontrado');
      }

      const feriado = result.rows[0];

      // Excluir
      await query(`DELETE FROM feriados WHERE id = $1`, [feriadoId]);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'feriados',
        descricao: `Feriado excluído: ${feriado.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir feriado:', error);
      return serverErrorResponse('Erro ao excluir feriado');
    }
  });
}
