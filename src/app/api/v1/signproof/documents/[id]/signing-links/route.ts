import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Proxy para o endpoint v1.x do SignProof — recupera os signing_links de
 * um documento já existente. Útil como fallback quando o response do /send
 * não trouxe os links (cliente esqueceu skip_email=true, ou doc antigo).
 *
 * Cada chamada gera entrada de auditoria `signing_links_retrieved` no
 * SignProof — tratar a resposta como dado sensível (token está na URL).
 */
export async function GET(request: NextRequest, ctx: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await ctx.params;
      const response = await fetch(
        `${SIGNPROOF_API_URL}/api/v1/integration/documents/${id}/signing-links`,
        {
          method: 'GET',
          headers: {
            'X-API-Key': SIGNPROOF_API_KEY!,
            Accept: 'application/json',
          },
        }
      );

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao buscar signing-links:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
