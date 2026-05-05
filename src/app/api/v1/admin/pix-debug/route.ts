import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { successResponse, serverErrorResponse } from '@/lib/api-response';

// GET /api/v1/admin/pix-debug?agendamentoId=50&limit=5
//
// Endpoint temporário pra inspecionar respostas brutas do Sicoob salvas em
// people.pagamento_pix. Útil pra diagnosticar falhas (NAO_REALIZADO,
// REJEITADO) sem precisar reproduzir o pagamento.

export async function GET(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const agendamentoId = searchParams.get('agendamentoId');
      const limit = Math.min(parseInt(searchParams.get('limit') ?? '10', 10), 50);

      const params: unknown[] = [];
      const where: string[] = [];
      if (agendamentoId) {
        params.push(agendamentoId);
        where.push(`agendamento_id = $${params.length}::bigint`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const r = await query(
        `SELECT id::text,
                agendamento_id,
                end_to_end_id,
                idempotency_key,
                status,
                cnpj_pagador,
                valor,
                destino_nome,
                destino_chave,
                tentativas,
                ultimo_erro,
                criado_em,
                confirmado_em,
                atualizado_em,
                resposta_iniciar,
                resposta_confirmar
           FROM people.pagamento_pix
           ${whereSql}
           ORDER BY criado_em DESC
           LIMIT ${limit}`,
        params,
      );

      return successResponse({ count: r.rows.length, rows: r.rows });
    } catch (error) {
      console.error('[admin/pix-debug] erro:', error);
      return serverErrorResponse('Erro ao consultar pagamento_pix');
    }
  });
}
