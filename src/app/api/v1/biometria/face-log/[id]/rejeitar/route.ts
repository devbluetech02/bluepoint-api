import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { updateFaceEvent } from '@/lib/face-log';

// POST /api/v1/biometria/face-log/:id/rejeitar
//
// Marca um log de reconhecimento como MATCH_REJECTED_BY_USER. Chamado
// quando o usuário clica "Não sou eu" no dialog de confirmação. Atualiza
// in-place o log gerado na 1ª chamada de /verificar-face — evita criar
// um row novo só pra rejeição.
//
// Sem auth: o cliente já tem o logId do response anterior (que foi
// gerado na sessão dele). Se alguém chutar IDs aleatórios, no pior caso
// reescreve o evento de logs alheios — não vaza dado nem permite ação
// crítica. Trade-off pra latência baixa no caminho do reconhecimento.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const logId = parseInt(id, 10);
    if (!Number.isFinite(logId) || logId <= 0) {
      return errorResponse('logId inválido', 400);
    }

    let motivo: string | null = null;
    try {
      const body = await request.json();
      if (typeof body?.motivo === 'string') motivo = body.motivo.slice(0, 200);
    } catch {
      // body opcional
    }

    await updateFaceEvent(logId, {
      evento: 'MATCH_REJECTED_BY_USER',
      colaboradorIdConfirmado: null,
      metadados: motivo ? { motivoRejeicao: motivo } : null,
    });

    return successResponse({ id: logId, evento: 'MATCH_REJECTED_BY_USER' });
  } catch (error) {
    console.error('[face-log/:id/rejeitar] erro:', error);
    return serverErrorResponse('Erro ao registrar rejeição');
  }
}
