import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/processos/:id/contrato-pdf
//
// Devolve o PDF mais recente do contrato no SignProof — o mesmo arquivo
// que o candidato vê na tela de assinatura. Quando o documento já estiver
// concluído (`status='completed'`), o PDF retornado inclui o certificado
// de assinaturas. O frontend usa este endpoint pra mostrar ao gestor a
// versão assinada em tempo real, sem precisar regenerar o preview.
//
// Se o processo ainda não tem `documento_assinatura_id` (caminho B ou
// caminho A antes do envio), responde 404 — o frontend cai pro preview
// gerado a partir do template (rota /dia-teste/preview).

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
        return notFoundResponse('Processo ainda não tem documento no SignProof');
      }

      const baseUrl = process.env.SIGNPROOF_API_URL;
      const apiKey = process.env.SIGNPROOF_API_KEY;
      if (!baseUrl || !apiKey) {
        return errorResponse('SignProof não configurada', 503);
      }

      const resp = await fetch(
        `${baseUrl}/api/v1/integration/documents/${proc.documento_assinatura_id}/download`,
        {
          headers: { 'X-API-Key': apiKey },
        }
      );
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return errorResponse(
          `SignProof respondeu ${resp.status}: ${t.slice(0, 200)}`,
          resp.status === 404 ? 404 : 502
        );
      }

      const buf = Buffer.from(await resp.arrayBuffer());

      return new NextResponse(buf, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="contrato-${proc.documento_assinatura_id}.pdf"`,
          'Cache-Control': 'no-store',
          'X-Document-Id': proc.documento_assinatura_id,
        },
      });
    } catch (error) {
      console.error(
        '[recrutamento/processos/:id/contrato-pdf] erro:',
        error
      );
      return serverErrorResponse('Erro ao baixar contrato do SignProof');
    }
  });
}
