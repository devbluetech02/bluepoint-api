import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import {
  successResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// POST /api/v1/recrutamento/feedback-pendente/:id/visto
//
// Recrutador clicou "ok" no popup. Marca visto_em = now() na linha,
// desde que ela pertença ao recrutador logado (segurança básica).

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (_req, user) => {
    try {
      const { id } = await params;
      const nome = (user.nome ?? '').trim().toUpperCase();
      if (!nome) return forbiddenResponse('Sem nome no token');

      const r = await query<{ recrutador_nome: string }>(
        `SELECT recrutador_nome FROM people.recrutador_avaliacao_ia
          WHERE id = $1::bigint LIMIT 1`,
        [id]
      );
      const linha = r.rows[0];
      if (!linha) return notFoundResponse('Avaliação não encontrada');
      if (linha.recrutador_nome !== nome) {
        return forbiddenResponse('Avaliação pertence a outro recrutador');
      }

      await query(
        `UPDATE people.recrutador_avaliacao_ia
            SET visto_em = now()
          WHERE id = $1::bigint
            AND visto_em IS NULL`,
        [id]
      );

      return successResponse({ id, visto: true });
    } catch (error) {
      console.error(
        '[recrutamento/feedback-pendente/:id/visto] erro:',
        error
      );
      return serverErrorResponse('Erro ao marcar feedback como visto');
    }
  });
}
