import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const response = await fetch(`${SIGNPROOF_API_URL}/api/v1/integration/templates`, {
        method: 'GET',
        headers: {
          'X-API-Key': SIGNPROOF_API_KEY!,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao buscar templates:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
