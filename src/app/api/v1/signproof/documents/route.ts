import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { errorResponse, serverErrorResponse } from '@/lib/api-response';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

// Prefixo de external_ref que identifica contratos do fluxo de pré-admissão.
// Nesses contratos o canal primário é WhatsApp (FLUXO_RECRUTAMENTO.md §3.3 e §4.2) —
// o proxy força notification_channel/auth_method pra garantir que chamadores
// antigos (ou a automação IA da Sprint 1.5) não degradem silenciosamente
// pra email.
const ADMISSAO_EXTERNAL_REF_PREFIX = 'ADM-';

interface SignerPayload {
  phone?: string;
  notification_channel?: string;
  auth_method?: string;
  [key: string]: unknown;
}

interface DocumentPayload {
  external_ref?: string;
  signers?: SignerPayload[];
  [key: string]: unknown;
}

/**
 * Se o documento é de pré-admissão, garante WhatsApp como canal primário
 * em TODOS os signatários e exige phone. Retorna null se OK, ou string com
 * a razão da rejeição (400) se faltar telefone.
 */
function enforceWhatsAppForAdmissao(body: DocumentPayload): string | null {
  const externalRef = typeof body.external_ref === 'string' ? body.external_ref : '';
  if (!externalRef.startsWith(ADMISSAO_EXTERNAL_REF_PREFIX)) return null;

  const signers = Array.isArray(body.signers) ? body.signers : [];
  if (signers.length === 0) return null;

  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    const phone = typeof signer.phone === 'string' ? signer.phone.trim() : '';
    if (!phone) {
      return `Signatário #${i + 1} precisa de "phone" — contratos de pré-admissão (external_ref ${ADMISSAO_EXTERNAL_REF_PREFIX}…) exigem WhatsApp.`;
    }
    // "both" é aceito (invite por whatsapp + email); só vira "whatsapp" se veio só email.
    if (signer.notification_channel !== 'both' && signer.notification_channel !== 'whatsapp') {
      signer.notification_channel = 'whatsapp';
    }
    signer.auth_method = 'whatsapp_token';
  }
  return null;
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = (await req.json()) as DocumentPayload;

      const enforceError = enforceWhatsAppForAdmissao(body);
      if (enforceError) return errorResponse(enforceError, 400);

      const response = await fetch(`${SIGNPROOF_API_URL}/api/v1/integration/documents`, {
        method: 'POST',
        headers: {
          'X-API-Key': SIGNPROOF_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error('[SignProof] Erro ao criar documento:', error);
      return serverErrorResponse('Erro ao comunicar com o serviço de assinatura digital');
    }
  });
}
