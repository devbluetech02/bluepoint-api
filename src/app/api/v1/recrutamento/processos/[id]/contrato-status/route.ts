import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/processos/:id/contrato-status
//
// Endpoint leve para polling do progresso do contrato no SignProof.
// Usa o endpoint single-doc `/integration/documents/:id/status` que
// devolve agregado + signers detalhados (sem signing_link, mais barato
// e sem dado sensível). Pensado pra ser chamado a cada ~30s pela
// web/mobile enquanto o gestor olha o modal de detalhe.

interface SignerProgresso {
  id: string;
  nome: string;
  email: string | null;
  role: string | null;
  signOrder: number | null;
  status: string;
  signedAt: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { id } = await params;

      const r = await query<{ documento_assinatura_id: string | null }>(
        `SELECT documento_assinatura_id
           FROM people.processo_seletivo
          WHERE id = $1::bigint
          LIMIT 1`,
        [id]
      );
      const proc = r.rows[0];
      if (!proc) return notFoundResponse('Processo seletivo não encontrado');

      if (!proc.documento_assinatura_id) {
        return successResponse({
          processoId: id,
          documentoId: null,
          status: null,
          signers: [],
          signedCount: 0,
          signerCount: 0,
          allSigned: false,
        });
      }

      const baseUrl = process.env.SIGNPROOF_API_URL;
      const apiKey = process.env.SIGNPROOF_API_KEY;
      if (!baseUrl || !apiKey) {
        return errorResponse('SignProof não configurada', 503);
      }

      const resp = await fetch(
        `${baseUrl}/api/v1/integration/documents/${proc.documento_assinatura_id}/status`,
        {
          headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        }
      );
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return errorResponse(
          `SignProof respondeu ${resp.status}: ${t.slice(0, 200)}`,
          502
        );
      }
      const data = (await resp.json()) as {
        status?: string;
        signer_count?: number;
        signed_count?: number;
        all_signed?: boolean;
        signers?: Array<{
          id?: string;
          name?: string;
          email?: string | null;
          role?: string | null;
          sign_order?: number | null;
          status?: string;
          signed_at?: string | null;
        }>;
      };

      const signers: SignerProgresso[] = (data.signers ?? []).map((s) => ({
        id: s.id ?? '',
        nome: s.name ?? '',
        email: s.email ?? null,
        role: s.role ?? null,
        signOrder: s.sign_order ?? null,
        status: s.status ?? 'pending',
        signedAt: s.signed_at ?? null,
      }));

      return successResponse({
        processoId: id,
        documentoId: proc.documento_assinatura_id,
        status: data.status ?? null,
        signedCount: data.signed_count ?? 0,
        signerCount: data.signer_count ?? signers.length,
        allSigned: data.all_signed ?? false,
        signers,
      });
    } catch (error) {
      console.error(
        '[recrutamento/processos/:id/contrato-status] erro:',
        error
      );
      return serverErrorResponse('Erro ao consultar status do contrato');
    }
  });
}
