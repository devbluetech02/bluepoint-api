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

      const response = await fetch(`${SIGNPROOF_API_URL}/api/v1/integration/documents/${id}/send`, {
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
