import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withPermission } from '@/lib/middleware';
import {
  successResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/avaliacoes-ia
//
// Lista paginada das avaliações IA gravadas em
// people.recrutador_avaliacao_ia. Pra Dev/CEO/superiores que precisam
// auditar o desempenho dos recrutadores.
//
// Auth: permissão granular `recrutamento:avaliacoes_ia:ver` (default
// concedida no nível 3 admin — atribuída a outros via modal de Cargo).
//
// Query params:
//   - recrutador (string)         — filtra por nome (UPPER+TRIM)
//   - veredito  ('bom'|'regular'|'ruim')
//   - periodoDe (yyyy-mm-dd)      — filtra por criado_em >=
//   - periodoAte (yyyy-mm-dd)     — filtra por criado_em <=
//   - page (int, default 1)
//   - limit (int, default 20, max 100)
//
// Resposta:
//   { items: [...], total, page, limit, recrutadores: [string] }
//   `recrutadores` traz o distinct de nomes pra alimentar o dropdown
//   de filtro no frontend.

export async function GET(request: NextRequest) {
  return withPermission(
    request,
    'recrutamento:avaliacoes_ia:ver',
    async (req) => {
      try {
        const url = new URL(req.url);
        const recrutador = (url.searchParams.get('recrutador') ?? '')
          .trim()
          .toUpperCase();
        const verediroRaw = url.searchParams.get('veredito') ?? '';
        const veredito =
          verediroRaw === 'bom' ||
          verediroRaw === 'regular' ||
          verediroRaw === 'ruim'
            ? verediroRaw
            : null;
        const periodoDe = (url.searchParams.get('periodoDe') ?? '').trim();
        const periodoAte = (url.searchParams.get('periodoAte') ?? '').trim();
        const page = Math.max(
          1,
          parseInt(url.searchParams.get('page') ?? '1', 10) || 1
        );
        const limit = Math.min(
          100,
          Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20)
        );
        const offset = (page - 1) * limit;

        // Monta filtros dinâmicos.
        const filtros: string[] = [];
        const params: unknown[] = [];
        let i = 1;
        if (recrutador) {
          filtros.push(`recrutador_nome = $${i++}`);
          params.push(recrutador);
        }
        if (veredito) {
          filtros.push(`veredito = $${i++}`);
          params.push(veredito);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(periodoDe)) {
          filtros.push(`criado_em >= $${i++}::date`);
          params.push(periodoDe);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(periodoAte)) {
          filtros.push(`criado_em < ($${i++}::date + INTERVAL '1 day')`);
          params.push(periodoAte);
        }
        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

        // Total + items + recrutadores distinct numa cadeia de queries.
        const countRes = await query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
             FROM people.recrutador_avaliacao_ia
             ${where}`,
          params
        );
        const total = parseInt(countRes.rows[0]?.total ?? '0', 10);

        const itemsRes = await query<{
          id: string;
          recrutador_nome: string;
          score: number;
          veredito: string;
          feedback_recrutador: string;
          feedback_gestor: string | null;
          pontos_fortes: unknown;
          pontos_fracos: unknown;
          entrevistas_avaliadas: number;
          periodo_de: Date;
          periodo_ate: Date;
          modelo_ia: string | null;
          criado_em: Date;
          visto_em: Date | null;
          notificou_gestor_em: Date | null;
        }>(
          `SELECT id::text, recrutador_nome, score, veredito,
                  feedback_recrutador, feedback_gestor,
                  pontos_fortes, pontos_fracos, entrevistas_avaliadas,
                  periodo_de, periodo_ate, modelo_ia,
                  criado_em, visto_em, notificou_gestor_em
             FROM people.recrutador_avaliacao_ia
             ${where}
            ORDER BY criado_em DESC
            LIMIT $${i++} OFFSET $${i++}`,
          [...params, limit, offset]
        );

        const recrutRes = await query<{ recrutador_nome: string }>(
          `SELECT DISTINCT recrutador_nome
             FROM people.recrutador_avaliacao_ia
            ORDER BY recrutador_nome ASC`
        );

        const items = itemsRes.rows.map((r) => ({
          id: r.id,
          recrutadorNome: r.recrutador_nome,
          score: r.score,
          veredito: r.veredito,
          feedbackRecrutador: r.feedback_recrutador,
          feedbackGestor: r.feedback_gestor,
          pontosFortes: Array.isArray(r.pontos_fortes) ? r.pontos_fortes : [],
          pontosFracos: Array.isArray(r.pontos_fracos) ? r.pontos_fracos : [],
          entrevistasAvaliadas: r.entrevistas_avaliadas,
          periodoDe: r.periodo_de,
          periodoAte: r.periodo_ate,
          modeloIa: r.modelo_ia,
          criadoEm: r.criado_em,
          vistoEm: r.visto_em,
          notificouGestorEm: r.notificou_gestor_em,
        }));

        return successResponse({
          items,
          total,
          page,
          limit,
          recrutadores: recrutRes.rows.map((r) => r.recrutador_nome),
        });
      } catch (error) {
        console.error('[recrutamento/avaliacoes-ia] erro:', error);
        return serverErrorResponse('Erro ao listar avaliações IA');
      }
    }
  );
}
