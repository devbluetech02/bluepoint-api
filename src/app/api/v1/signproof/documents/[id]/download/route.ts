import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;

      const response = await fetch(`${SIGNPROOF_API_URL}/api/v1/integration/documents/${id}/download`, {
        method: 'GET',
        headers: {
          'X-API-Key': SIGNPROOF_API_KEY!,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro ao baixar documento' }));
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
      console.error('[SignProof] Erro ao baixar documento:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
