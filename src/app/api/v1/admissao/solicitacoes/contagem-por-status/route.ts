import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';

/**
 * GET /api/v1/admissao/solicitacoes/contagem-por-status
 *
 * Devolve a contagem de solicitações agrupadas por status, respeitando a
 * mesma regra de dedup do endpoint de listagem (apenas a solicitação mais
 * recente por usuario_provisorio_id). Usado pela barra de fases na aba
 * "Pré-admitidos" pra mostrar quantos itens existem em cada fase.
 *
 * Não aceita filtro por status (seria circular). Tokens provisórios só
 * contam as próprias solicitações.
 */
export async function GET(request: NextRequest) {
  return withAdmissao(request, async (_req, user) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (user.tipo === 'provisorio') {
        params.push(user.userId);
        conditions.push(`s.usuario_provisorio_id = $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await query<{ status: string; total: string }>(
        `WITH filtradas AS (
           SELECT s.status,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(s.usuario_provisorio_id::text, s.id::text)
                    ORDER BY s.criado_em DESC
                  ) AS rn
           FROM people.solicitacoes_admissao s
           ${where}
         )
         SELECT status, COUNT(*) AS total
           FROM filtradas
          WHERE rn = 1
          GROUP BY status`,
        params,
      );

      const counts: Record<string, number> = {};
      let total = 0;
      for (const row of result.rows) {
        const n = parseInt(row.total, 10);
        counts[row.status] = n;
        total += n;
      }

      return successResponse({ counts, total });
    } catch (error) {
      console.error('Erro ao contar solicitações por status:', error);
      return serverErrorResponse('Erro ao contar solicitações por status');
    }
  });
}
