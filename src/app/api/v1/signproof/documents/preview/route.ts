import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

export async function POST(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const body = await request.text();

      const response = await fetch(`${SIGNPROOF_API_URL}/api/v1/integration/documents/preview`, {
        method: 'POST',
        headers: {
          'X-API-Key': SIGNPROOF_API_KEY!,
          'Content-Type': 'application/json',
        },
        body,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro ao gerar preview do documento' }));
        return NextResponse.json(errorData, { status: response.status });
      }

      const buffer = await response.arrayBuffer();

      const headers = new Headers();
      headers.set('Content-Type', response.headers.get('Content-Type') ?? 'application/pdf');
      const contentDisposition = response.headers.get('Content-Disposition');
      if (contentDisposition) {
        headers.set('Content-Disposition', contentDisposition);
      }

      return new NextResponse(buffer, { status: 200, headers });
    } catch (error) {
      console.error('[SignProof] Erro ao gerar preview do documento:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
