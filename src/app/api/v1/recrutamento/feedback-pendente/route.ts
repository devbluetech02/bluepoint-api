import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import {
  successResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/feedback-pendente
//
// Devolve o feedback IA mais recente do recrutador logado que ainda
// não foi visto. O frontend usa pra renderizar o popup ao logar.
// Recrutador é identificado pelo `nome` do JWT (normalizado UPPER).
//
// Resposta:
//   - 200 com `null` se não há feedback pendente
//   - 200 com objeto se há

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      const nome = (user.nome ?? '').trim().toUpperCase();
      if (!nome) {
        return successResponse(null);
      }

      const r = await query<{
        id: string;
        score: number;
        veredito: string;
        feedback_recrutador: string;
        pontos_fortes: unknown;
        pontos_fracos: unknown;
        entrevistas_avaliadas: number;
        criado_em: Date;
      }>(
        `SELECT id::text, score, veredito, feedback_recrutador,
                pontos_fortes, pontos_fracos, entrevistas_avaliadas, criado_em
           FROM people.recrutador_avaliacao_ia
          WHERE recrutador_nome = $1
            AND visto_em IS NULL
          ORDER BY criado_em DESC
          LIMIT 1`,
        [nome]
      );

      if (r.rows.length === 0) {
        return successResponse(null);
      }

      const row = r.rows[0];
      return successResponse({
        id: row.id,
        score: row.score,
        veredito: row.veredito,
        feedbackRecrutador: row.feedback_recrutador,
        pontosFortes: Array.isArray(row.pontos_fortes) ? row.pontos_fortes : [],
        pontosFracos: Array.isArray(row.pontos_fracos) ? row.pontos_fracos : [],
        entrevistasAvaliadas: row.entrevistas_avaliadas,
        criadoEm: row.criado_em,
      });
    } catch (error) {
      console.error('[recrutamento/feedback-pendente] erro:', error);
      return serverErrorResponse('Erro ao consultar feedback pendente');
    }
  });
}
