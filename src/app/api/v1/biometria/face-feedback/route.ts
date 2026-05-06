import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logFaceEventAsync, type FaceEventType } from '@/lib/face-log';
import { getClientIp, getUserAgent } from '@/lib/audit';

/**
 * POST /api/v1/biometria/face-feedback
 *
 * Endpoint dedicado para o cliente reportar eventos de feedback do
 * usuário ao sistema de reconhecimento facial. Atualmente cobre:
 *
 *  - MATCH_REJECTED_BY_USER: usuário clicou "Não sou eu" no modal
 *    inicial de confirmação (após /verificar-face).
 *  - TIEBREAK_REJECTED_BY_USER: usuário clicou "Não sou eu" no
 *    modal pós-tiebreak (após /tiebreak-face).
 *
 * São dados de telemetria pra análise — não retorna nada útil
 * de volta. Best-effort, falha graciosa.
 */

const schema = z.object({
  evento: z.enum(['MATCH_REJECTED_BY_USER', 'TIEBREAK_REJECTED_BY_USER']),
  origem: z.string().optional(),
  colaboradorIdProposto: z.number().int().positive().optional(),
  distanciaTop1: z.number().optional(),
  distanciaTop2: z.number().optional(),
  qualidade: z.number().optional(),
  dispositivoCodigo: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  llmModelo: z.string().optional(),
  llmConfidence: z.number().optional(),
  metadados: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { success: false, error: 'JSON inválido', code: 'INVALID_JSON' },
        { status: 400 },
      );
    }
    const validation = schema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Erro de validação',
          code: 'VALIDATION_ERROR',
          details: validation.error.issues,
        },
        { status: 422 },
      );
    }
    const data = validation.data;

    logFaceEventAsync({
      evento: data.evento as FaceEventType,
      endpoint: 'feedback',
      origem: data.origem ?? null,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      dispositivoCodigo: data.dispositivoCodigo ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      qualidade: data.qualidade ?? null,
      colaboradorIdProposto: data.colaboradorIdProposto ?? null,
      distanciaTop1: data.distanciaTop1 ?? null,
      distanciaTop2: data.distanciaTop2 ?? null,
      llmModelo: data.llmModelo ?? null,
      llmConfidence: data.llmConfidence ?? null,
      metadados: data.metadados ?? null,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[face-feedback] erro:', e);
    return NextResponse.json(
      { success: false, error: 'Erro interno', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
