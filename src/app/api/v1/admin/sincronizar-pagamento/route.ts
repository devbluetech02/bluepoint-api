import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, errorResponse } from '@/lib/api-response';
import { consultarPagamentoPix } from '@/lib/pix-pagamentos';

// POST /api/v1/admin/sincronizar-pagamento
// body: { pagamentoId?: string, agendamentoId?: string }
//
// Variante admin (auth via CRON_SECRET) do route /pagamento/sincronizar.
// Útil pra forçar a transição enviado→sucesso quando o app não chama
// sincronizar automaticamente. Usa exatamente a mesma lógica do route
// público; replica aqui pra evitar refactor do middleware.

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      pagamentoId?: string; agendamentoId?: string;
    };

    let pagRes;
    if (body.pagamentoId) {
      pagRes = await query<{ id: string; end_to_end_id: string | null; status: string; agendamento_id: string }>(
        `SELECT id::text, end_to_end_id, status, agendamento_id::text FROM people.pagamento_pix WHERE id = $1::bigint LIMIT 1`,
        [body.pagamentoId],
      );
    } else if (body.agendamentoId) {
      pagRes = await query<{ id: string; end_to_end_id: string | null; status: string; agendamento_id: string }>(
        `SELECT id::text, end_to_end_id, status, agendamento_id::text
           FROM people.pagamento_pix
          WHERE agendamento_id = $1::bigint
            AND status IN ('iniciado','enviado','sucesso','falha')
          ORDER BY criado_em DESC LIMIT 1`,
        [body.agendamentoId],
      );
    } else {
      return errorResponse('Manda pagamentoId ou agendamentoId', 400);
    }

    const pag = pagRes.rows[0];
    if (!pag) return errorResponse('pagamento_pix não encontrado', 404);
    if (!pag.end_to_end_id) return errorResponse('pagamento sem endToEndId', 409);

    if (pag.status === 'sucesso' || pag.status === 'falha') {
      return successResponse({ pagamentoId: pag.id, status: pag.status, changed: false, terminal: true });
    }

    const r = await consultarPagamentoPix(pag.end_to_end_id);
    if (!r.ok) return errorResponse(`Falha ao consultar Sicoob: ${r.erro}`, 502);

    const estado = (r.data.estado ?? '').toUpperCase();
    let novoStatus: 'sucesso' | 'falha' | 'enviado';
    if (['REALIZADO', 'LIQUIDADO', 'SUCESSO', 'SUCCESS', 'EFETIVADO'].includes(estado)) novoStatus = 'sucesso';
    else if (['REJEITADO', 'NAO_REALIZADO', 'FALHA', 'FAILED'].includes(estado)) novoStatus = 'falha';
    else novoStatus = 'enviado';

    const changed = novoStatus !== pag.status;
    if (changed) {
      await query(
        `UPDATE people.pagamento_pix
            SET status = $1,
                resposta_confirmar = COALESCE(resposta_confirmar, $2::jsonb),
                ultimo_erro = $3,
                atualizado_em = NOW()
          WHERE id = $4::bigint`,
        [novoStatus, JSON.stringify(r.data), r.data.detalheRejeicao ?? null, pag.id],
      );
    }

    if (changed && novoStatus === 'sucesso') {
      const { lancarPagamentoPixWinthorPorId } = await import('@/lib/winthor-pagamento');
      // Espera concluir pra responder com o RECNUM (pra debug do user).
      const winRes = await lancarPagamentoPixWinthorPorId(pag.id).catch((err) => ({
        ok: false, motivo: (err as Error).message,
      }));
      return successResponse({
        pagamentoId: pag.id, status: novoStatus, changed, estadoSicoob: estado, winthor: winRes,
      });
    }

    return successResponse({
      pagamentoId: pag.id, status: novoStatus, changed, estadoSicoob: estado,
      detalheRejeicao: r.data.detalheRejeicao ?? null,
    });
  } catch (e) {
    console.error('[admin/sincronizar-pagamento]', e);
    return serverErrorResponse((e as Error).message);
  }
}
