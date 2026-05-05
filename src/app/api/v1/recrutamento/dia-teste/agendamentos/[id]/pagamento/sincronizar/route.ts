import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { consultarPagamentoPix } from '@/lib/pix-pagamentos';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/pagamento/sincronizar
//
// Consulta a Sicoob via GET /pix-pagamentos/v2/{endToEndId} e atualiza
// `pagamento_pix.status` local quando o estado mudar (EM_PROCESSAMENTO →
// REALIZADO/REJEITADO/etc). API BT possui Guardian que sincroniza no GET,
// entao essa chamada eh suficiente pra trazer o estado mais recente.
//
// Mobile pode chamar este endpoint apos confirmar pra confirmar liquidacao,
// ou polling-style enquanto status local for 'enviado'.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withGestor(request, async () => {
    try {
      const { id } = await params;

      const pagRes = await query<{
        id: string;
        end_to_end_id: string | null;
        status: string;
      }>(
        `SELECT id::text, end_to_end_id, status
           FROM people.pagamento_pix
          WHERE agendamento_id = $1::bigint
            AND status IN ('iniciado','enviado','sucesso','falha')
          ORDER BY criado_em DESC
          LIMIT 1`,
        [id],
      );
      const pag = pagRes.rows[0];
      if (!pag) return notFoundResponse('Pagamento não encontrado');
      if (!pag.end_to_end_id) {
        return errorResponse('Pagamento sem endToEndId', 409);
      }
      // Status terminais — não consulta de novo.
      if (pag.status === 'sucesso' || pag.status === 'falha') {
        return successResponse({
          pagamentoId: pag.id,
          status: pag.status,
          estadoSicoob: null,
          changed: false,
        });
      }

      const r = await consultarPagamentoPix(pag.end_to_end_id);
      if (!r.ok) {
        return errorResponse(`Falha ao consultar Sicoob: ${r.erro}`, 502);
      }
      const estado = (r.data.estado ?? '').toUpperCase();
      let novoStatus: 'sucesso' | 'falha' | 'enviado';
      if (['REALIZADO', 'LIQUIDADO', 'SUCESSO', 'SUCCESS', 'EFETIVADO'].includes(estado)) {
        novoStatus = 'sucesso';
      } else if (['REJEITADO', 'NAO_REALIZADO', 'FALHA', 'FAILED'].includes(estado)) {
        novoStatus = 'falha';
      } else {
        novoStatus = 'enviado';
      }
      const changed = novoStatus !== pag.status;
      if (changed) {
        await query(
          `UPDATE people.pagamento_pix
              SET status = $1,
                  resposta_confirmar = COALESCE(resposta_confirmar, $2::jsonb),
                  ultimo_erro = $3,
                  atualizado_em = NOW()
            WHERE id = $4::bigint`,
          [
            novoStatus,
            JSON.stringify(r.data),
            r.data.detalheRejeicao ?? null,
            pag.id,
          ],
        );
      }
      return successResponse({
        pagamentoId: pag.id,
        status: novoStatus,
        estadoSicoob: estado || null,
        detalheRejeicao: r.data.detalheRejeicao ?? null,
        changed,
      });
    } catch (error) {
      console.error('[pagamento/sincronizar] erro:', error);
      return serverErrorResponse('Erro ao sincronizar pagamento PIX');
    }
  });
}
