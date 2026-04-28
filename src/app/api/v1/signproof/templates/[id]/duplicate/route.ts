import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Proxy para o endpoint v1.5.0 do SignProof — clona um template existente
 * (UUID custom da empresa OU string global como `contratacao_v1`) gerando
 * uma cópia editável com UUID novo, vinculada à empresa do chamador.
 *
 * Body opcional: { name?, description?, category? } — sem body, a cópia
 * herda o nome do original com sufixo " (Cópia)".
 *
 * Retorna 201 Created com o template novo (mesmo formato do GET /:id).
 */
export async function POST(request: NextRequest, ctx: Params) {
  return withAuth(request, async (req) => {
    try {
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const response = await fetch(
        `${SIGNPROOF_API_URL}/api/v1/integration/templates/${encodeURIComponent(id)}/duplicate`,
        {
          method: 'POST',
          headers: {
            'X-API-Key': SIGNPROOF_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body ?? {}),
        }
      );

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao clonar template:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
