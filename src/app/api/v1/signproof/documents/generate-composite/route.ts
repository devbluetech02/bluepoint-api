import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { serverErrorResponse } from '@/lib/api-response';
import { resolveImageVariables } from '@/lib/signproof-image-resolver';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

interface CompositePart {
  template_id?: string;
  variables?: Record<string, unknown>;
}

interface CompositeBody {
  primary_template?: CompositePart;
  supplements?: CompositePart[];
  name?: string;
  letterhead_id?: string;
}

/**
 * POST /api/v1/signproof/documents/generate-composite
 *
 * Proxy para o endpoint nativo da SignProof que faz merge de PDFs via pdfcpu.
 * Recebe 1 template primário + N supplements, retorna file_key + pdf_base64
 * com o PDF unificado. Não cria envelope assinável — a criação do documento
 * com signers deve ser feita em chamada separada usando o file_key retornado.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = (await req.json()) as CompositeBody;

      // Resolve URLs de imagem (foto_colaborador, logo_empresa, ...) em data
      // URI base64 — mesma estratégia do POST /signproof/documents.
      if (body.primary_template?.variables) {
        await resolveImageVariables(
          body.primary_template.variables as Record<string, unknown>,
        );
      }
      if (Array.isArray(body.supplements)) {
        for (const s of body.supplements) {
          if (s.variables) {
            await resolveImageVariables(s.variables as Record<string, unknown>);
          }
        }
      }

      const response = await fetch(
        `${SIGNPROOF_API_URL}/api/v1/documents/generate-composite`,
        {
          method: 'POST',
          headers: {
            'X-API-Key': SIGNPROOF_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro generate-composite:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
