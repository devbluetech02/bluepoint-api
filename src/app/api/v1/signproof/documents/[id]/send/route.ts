import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;

      // Repassa toda a query string (skip_email=true é a mais importante —
      // ela é o que faz o SignProof devolver `signing_links` no body em vez
      // de só disparar email/WhatsApp internamente). Sem isso, o People
      // manda WhatsApp pro candidato sem o link de assinatura.
      const qs = request.nextUrl.search; // inclui o "?" se houver query
      const url = `${SIGNPROOF_API_URL}/api/v1/integration/documents/${id}/send${qs}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-API-Key': SIGNPROOF_API_KEY!,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao enviar documento:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
