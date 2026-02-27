import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const feriasId = parseInt(id);

      if (isNaN(feriasId)) {
        return notFoundResponse('Período de férias não encontrado');
      }

      const result = await query(
        `SELECT
          pf.id,
          pf.colaborador_id,
          c.nome as colaborador_nome,
          c.email as colaborador_email,
          pf.data_inicio,
          pf.data_fim,
          pf.solicitacao_id,
          pf.observacao,
          pf.designado_por,
          d.nome as designado_por_nome,
          pf.criado_em,
          (pf.data_fim::date - pf.data_inicio::date + 1) as dias
        FROM bluepoint.bt_periodos_ferias pf
        JOIN bluepoint.bt_colaboradores c ON pf.colaborador_id = c.id
        LEFT JOIN bluepoint.bt_colaboradores d ON pf.designado_por = d.id
        WHERE pf.id = $1`,
        [feriasId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Período de férias não encontrado');
      }

      const row = result.rows[0];

      return successResponse({
        id: row.id,
        colaborador: { id: row.colaborador_id, nome: row.colaborador_nome, email: row.colaborador_email },
        dataInicio: row.data_inicio,
        dataFim: row.data_fim,
        dias: parseInt(row.dias),
        solicitacaoId: row.solicitacao_id,
        observacao: row.observacao,
        designadoPor: row.designado_por ? { id: row.designado_por, nome: row.designado_por_nome } : null,
        criadoEm: row.criado_em,
      });
    } catch (error) {
      console.error('Erro ao obter férias:', error);
      return serverErrorResponse('Erro ao obter férias');
    }
  });
}
