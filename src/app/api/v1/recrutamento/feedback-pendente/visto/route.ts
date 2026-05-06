import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import { normalizarNomeRecrutador, SQL_NORMALIZE_NOME } from '@/lib/normalizar-nome';
import {
  successResponse,
  forbiddenResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// POST /api/v1/recrutamento/feedback-pendente/visto
//
// Recrutador clicou "ok" no popup. Marca TODAS as avaliações pendentes
// dele (visto_em IS NULL) como vistas em um único UPDATE.
//
// Substitui a rota anterior `/feedback-pendente/:id/visto` (que marcava
// uma linha por vez) — agora o popup agrega o histórico desde o último
// visto, então o "Entendi" precisa fechar todas de uma vez.

export async function POST(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      const nome = normalizarNomeRecrutador(user.nome);
      if (!nome) return forbiddenResponse('Sem nome no token');

      // Match accent/case-insensitive — recrutador_nome no banco vem
      // gravado com SQL_NORMALIZE_NOME pelo cron, mas JS-side
      // normalizarNomeRecrutador pode discordar em edge cases (espacos
      // extras, caracteres ñ, etc). Compara ambos os lados normalizados
      // pra garantir match.
      const r = await query<{ id: string }>(
        `UPDATE people.recrutador_avaliacao_ia
            SET visto_em = now()
          WHERE ${SQL_NORMALIZE_NOME('recrutador_nome')} = ${SQL_NORMALIZE_NOME('$1')}
            AND visto_em IS NULL
        RETURNING id::text`,
        [nome]
      );

      if (r.rows.length === 0) {
        console.warn(
          `[feedback-pendente/visto] marcadas=0 user="${user.nome}" normalizado="${nome}" — provavel mismatch entre nome no JWT e recrutador_nome gravado`
        );
      }

      return successResponse({
        marcadas: r.rows.length,
        ids: r.rows.map((row) => row.id),
      });
    } catch (error) {
      console.error('[recrutamento/feedback-pendente/visto] erro:', error);
      return serverErrorResponse('Erro ao marcar feedback como visto');
    }
  });
}
