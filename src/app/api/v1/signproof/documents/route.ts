import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { errorResponse, serverErrorResponse } from '@/lib/api-response';
import { resolveImageVariables } from '@/lib/signproof-image-resolver';

const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

// Prefixo de external_ref que identifica contratos do fluxo de pré-admissão.
// Esses contratos exigem WhatsApp pra que o OTP (auth_method=whatsapp_token)
// possa ser disparado — o invite/notification_channel fica como o front
// definiu (geralmente "email", canal mais persistente para o link de assinatura).
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
 * Pré-admissão exige phone em TODOS os signatários (auth_method=whatsapp_token
 * usa o telefone pra disparar o OTP). Não força mais notification_channel —
 * o front escolhe o canal do convite (default: email).
 *
 * Retorna null se OK, ou string com a razão da rejeição (400) se faltar telefone.
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
      return `Signatário #${i + 1} precisa de "phone" — contratos de pré-admissão (external_ref ${ADMISSAO_EXTERNAL_REF_PREFIX}…) exigem WhatsApp para o OTP.`;
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = (await req.json()) as DocumentPayload;

      const enforceError = enforceWhatsAppForAdmissao(body);
      if (enforceError) return errorResponse(enforceError, 400);

      // Converte URLs de imagem (foto_colaborador, logo_empresa, …) em data
      // URI base64 — sem isso, SignProof renderiza a URL como texto.
      await resolveImageVariables(
        body.variables as Record<string, unknown> | undefined,
      );

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
