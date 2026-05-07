import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { lancarPagamentoPixWinthorPorId } from '@/lib/winthor-pagamento';
import { successResponse, serverErrorResponse } from '@/lib/api-response';

// POST /api/v1/cron/winthor-retry-pagamentos
//
// Reprocessa pagamentos PIX com status='sucesso' que ainda não foram
// lançados no Winthor (winthor_recnum IS NULL). Cron chama em janela
// curta de tempo após o disparo síncrono falhar (Winthor offline,
// timeout, conexão Oracle caída, etc).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: vazio.
//
// Retorna { processados, sucesso, falha, detalhes }.

function checarAuth(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!checarAuth(request)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  try {
    const r = await query<{ id: string }>(
      `SELECT id::text
         FROM people.pagamento_pix
        WHERE status = 'sucesso'
          AND winthor_recnum IS NULL
        ORDER BY confirmado_em ASC NULLS LAST, id ASC
        LIMIT 50`,
    );
    const pendentes = r.rows.map((x) => x.id);
    let sucesso = 0, falha = 0;
    const detalhes: Array<{ id: string; ok: boolean; recnum?: number; motivo?: string }> = [];
    for (const id of pendentes) {
      const res = await lancarPagamentoPixWinthorPorId(id);
      if (res.ok && res.recnum) {
        sucesso += 1;
        detalhes.push({ id, ok: true, recnum: res.recnum });
      } else if (res.pulado) {
        // Não conta como falha — só pulou (já lançado / sem cod_filial / etc).
        detalhes.push({ id, ok: false, motivo: res.motivo });
      } else {
        falha += 1;
        detalhes.push({ id, ok: false, motivo: res.motivo });
      }
    }
    return successResponse({ processados: pendentes.length, sucesso, falha, detalhes });
  } catch (e) {
    console.error('[cron/winthor-retry-pagamentos] erro:', e);
    return serverErrorResponse('Erro no cron retry Winthor');
  }
}
