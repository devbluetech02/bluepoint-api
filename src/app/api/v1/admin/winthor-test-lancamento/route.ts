import { NextRequest, NextResponse } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { lancarPagamentoPixNoWinthor } from '@/lib/winthor';

// POST /api/v1/admin/winthor-test-lancamento
// body: { cargo?: string, valor?: number, nomeCandidato?: string, hashtag?: string }
//
// Endpoint TEMPORÁRIO de debug — dispara um INSERT em PCLANC + PCRATEIOCENTROCUSTO
// pra validar a mecânica do rateio sem depender de pagamento real. Auth via
// CRON_SECRET. APAGAR depois.

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      cargo?: string; valor?: number; nomeCandidato?: string; hashtag?: string;
    };
    const res = await lancarPagamentoPixNoWinthor({
      nomeCandidato: body.nomeCandidato || 'TESTE INTEGRACAO API',
      cargo: body.cargo || 'VENDEDOR INTERNO',
      hashtag: body.hashtag || 'TEST',
      valor: typeof body.valor === 'number' ? body.valor : 0.01,
      chavePix: '00000000000',
      tipoChave: 'cpf',
      nomeFunc: 'PEOPLEAPI',
    });
    return successResponse(res);
  } catch (e) {
    console.error('[winthor-test-lancamento]', e);
    return serverErrorResponse((e as Error).message);
  }
}
