import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const feriasId = parseInt(id);

      if (isNaN(feriasId)) {
        return notFoundResponse('Período de férias não encontrado');
      }

      const result = await query(
        `SELECT pf.id, pf.colaborador_id, pf.data_inicio, pf.data_fim, c.nome as colaborador_nome
         FROM bluepoint.bt_periodos_ferias pf
         JOIN bluepoint.bt_colaboradores c ON pf.colaborador_id = c.id
         WHERE pf.id = $1`,
        [feriasId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Período de férias não encontrado');
      }

      const periodo = result.rows[0];

      await query(
        `DELETE FROM bluepoint.bt_periodos_ferias WHERE id = $1`,
        [feriasId]
      );

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'ferias',
        descricao: `Férias removidas de ${periodo.colaborador_nome}: ${periodo.data_inicio} a ${periodo.data_fim}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: {
          id: feriasId,
          colaboradorId: periodo.colaborador_id,
          dataInicio: periodo.data_inicio,
          dataFim: periodo.data_fim,
        },
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir férias:', error);
      return serverErrorResponse('Erro ao excluir férias');
    }
  });
}
