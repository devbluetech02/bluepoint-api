import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await ctx.params;
      const response = await fetch(
        `${SIGNPROOF_API_URL}/api/v1/integration/templates/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: {
            'X-API-Key': SIGNPROOF_API_KEY!,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao buscar template:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}

export async function PUT(request: NextRequest, ctx: Params) {
  return withAuth(request, async (req) => {
    try {
      const { id } = await ctx.params;
      const body = await req.json();
      const response = await fetch(
        `${SIGNPROOF_API_URL}/api/v1/integration/templates/${encodeURIComponent(id)}`,
        {
          method: 'PUT',
          headers: {
            'X-API-Key': SIGNPROOF_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao atualizar template:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}

export async function DELETE(request: NextRequest, ctx: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await ctx.params;
      const response = await fetch(
        `${SIGNPROOF_API_URL}/api/v1/integration/templates/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {
            'X-API-Key': SIGNPROOF_API_KEY!,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.status === 204) {
        return new NextResponse(null, { status: 204 });
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : { success: true };
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao remover template:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
