import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse, notFoundResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { marcarAlertaLido, arquivarAlerta } from '@/lib/ai-analytics';
import { query } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { id } = await params;
      const alertaId = parseInt(id);
      if (isNaN(alertaId)) return errorResponse('ID invalido', 400);

      const result = await query(
        'SELECT ai.*, e.nome_fantasia as empresa_nome FROM bluepoint.bt_alertas_inteligentes ai LEFT JOIN bluepoint.bt_empresas e ON ai.empresa_id = e.id WHERE ai.id = $1',
        [alertaId]
      );

      if (result.rows.length === 0) return notFoundResponse('Alerta nao encontrado');

      const r = result.rows[0];
      return successResponse({
        id: r.id, empresaId: r.empresa_id, empresaNome: r.empresa_nome,
        categoria: r.categoria, severidade: r.severidade, titulo: r.titulo,
        mensagem: r.mensagem, dados: r.dados, origem: r.origem,
        lido: r.lido, arquivado: r.arquivado, criadoEm: r.criado_em,
      });
    } catch (error) {
      console.error('Erro ao obter alerta:', error);
      return serverErrorResponse('Erro ao obter alerta');
    }
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { id } = await params;
      const alertaId = parseInt(id);
      if (isNaN(alertaId)) return errorResponse('ID invalido', 400);

      const body = await request.json();
      let atualizado = false;

      if (body.lido === true) {
        atualizado = await marcarAlertaLido(alertaId);
      }
      if (body.arquivado === true) {
        atualizado = await arquivarAlerta(alertaId);
      }

      if (!atualizado) return notFoundResponse('Alerta nao encontrado');
      return successResponse({ mensagem: 'Alerta atualizado com sucesso' });
    } catch (error) {
      console.error('Erro ao atualizar alerta:', error);
      return serverErrorResponse('Erro ao atualizar alerta');
    }
  });
}
