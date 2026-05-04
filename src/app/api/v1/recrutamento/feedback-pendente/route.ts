import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import { normalizarNomeRecrutador } from '@/lib/normalizar-nome';
import {
  successResponse,
  serverErrorResponse,
} from '@/lib/api-response';

/** True se o nome do cargo identifica um recrutador (cobre variações:
 * "Recrutador", "Recrutadora", "Analista de Recrutamento", "Recrutador(a)").
 * Match accent-insensitive em UPPER. */
function ehCargoRecrutador(cargoNome: string | null | undefined): boolean {
  if (!cargoNome) return false;
  const norm = normalizarNomeRecrutador(cargoNome);
  return norm.includes('RECRUTADOR') || norm.includes('RECRUTAMENTO');
}

// GET /api/v1/recrutamento/feedback-pendente
//
// Devolve a lista AGREGADA de avaliações IA pendentes (visto_em IS NULL)
// do recrutador logado, gateada pelos parâmetros de popup em
// people.parametros_rh:
//
//   - popup_modo='por_avaliacao': só retorna se a quantidade de
//     pendentes >= popup_intervalo (ex.: 3 → só aparece quando há 3
//     avaliações novas acumuladas).
//   - popup_modo='por_dias': só retorna se passaram >= popup_intervalo
//     dias desde o último popup visto pelo recrutador (max(visto_em))
//     E há ao menos uma avaliação pendente. Se nunca viu nenhuma,
//     mostra na primeira vez que houver pendência.
//
// Resposta:
//   - 200 com `null` se não há pendência ou gating ainda não permite
//   - 200 com `{ total, periodoDe, periodoAte, avaliacoes: [...] }`
//     em ordem cronológica (mais antiga → mais recente).

interface PendenteRow {
  id: string;
  score: number;
  veredito: string;
  feedback_recrutador: string;
  pontos_fortes: unknown;
  pontos_fracos: unknown;
  entrevistas_avaliadas: number;
  criado_em: Date;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      const nome = normalizarNomeRecrutador(user.nome);
      if (!nome) {
        return successResponse(null);
      }

      // Gate por cargo: popup só aparece se o cargo do usuário for
      // recrutador (cobre "Recrutador", "Recrutadora", cargos com
      // "Recrutamento" no nome). Match accent-insensitive.
      const cargoRes = await query<{ cargo_nome: string | null }>(
        `SELECT cg.nome AS cargo_nome
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
          WHERE c.id = $1
          LIMIT 1`,
        [user.userId]
      );
      if (!ehCargoRecrutador(cargoRes.rows[0]?.cargo_nome)) {
        return successResponse(null);
      }

      // Lê parâmetros de popup. Se a feature toda estiver pausada, nem
      // mostra. Defaults seguros se a row de parametros_rh ainda não
      // existir (banco fresco).
      const paramRes = await query<{
        popup_modo: string | null;
        popup_intervalo: number | string | null;
        avaliacao_ia_ativa: boolean | null;
      }>(
        `SELECT popup_modo, popup_intervalo, avaliacao_ia_ativa
           FROM people.parametros_rh
          ORDER BY id DESC
          LIMIT 1`
      );

      const param = paramRes.rows[0];
      const ativa = param?.avaliacao_ia_ativa ?? true;
      if (!ativa) return successResponse(null);

      const modo: 'por_avaliacao' | 'por_dias' =
        param?.popup_modo === 'por_dias' ? 'por_dias' : 'por_avaliacao';
      const intervalo = Math.max(
        1,
        Math.min(365, Number(param?.popup_intervalo ?? 1))
      );

      // Pega TODAS as pendentes do recrutador.
      const pendRes = await query<PendenteRow>(
        `SELECT id::text, score, veredito, feedback_recrutador,
                pontos_fortes, pontos_fracos, entrevistas_avaliadas, criado_em
           FROM people.recrutador_avaliacao_ia
          WHERE recrutador_nome = $1
            AND visto_em IS NULL
          ORDER BY criado_em ASC`,
        [nome]
      );

      const pendentes = pendRes.rows;
      if (pendentes.length === 0) {
        return successResponse(null);
      }

      // Aplica gating conforme o modo.
      if (modo === 'por_avaliacao') {
        if (pendentes.length < intervalo) {
          return successResponse(null);
        }
      } else {
        // por_dias: precisa ter passado N dias desde o último popup visto.
        const ultRes = await query<{ ultimo: Date | null }>(
          `SELECT MAX(visto_em) AS ultimo
             FROM people.recrutador_avaliacao_ia
            WHERE recrutador_nome = $1
              AND visto_em IS NOT NULL`,
          [nome]
        );
        const ultimoVisto = ultRes.rows[0]?.ultimo ?? null;
        if (ultimoVisto != null) {
          const diffMs = Date.now() - new Date(ultimoVisto).getTime();
          const dias = diffMs / (1000 * 60 * 60 * 24);
          if (dias < intervalo) {
            return successResponse(null);
          }
        }
        // Se nunca viu nenhuma, mostra direto na primeira pendência.
      }

      const avaliacoes = pendentes.map((row) => ({
        id: row.id,
        score: row.score,
        veredito: row.veredito,
        feedbackRecrutador: row.feedback_recrutador,
        pontosFortes: Array.isArray(row.pontos_fortes) ? row.pontos_fortes : [],
        pontosFracos: Array.isArray(row.pontos_fracos) ? row.pontos_fracos : [],
        entrevistasAvaliadas: row.entrevistas_avaliadas,
        criadoEm: row.criado_em,
      }));

      return successResponse({
        total: avaliacoes.length,
        periodoDe: avaliacoes[0].criadoEm,
        periodoAte: avaliacoes[avaliacoes.length - 1].criadoEm,
        avaliacoes,
      });
    } catch (error) {
      console.error('[recrutamento/feedback-pendente] erro:', error);
      return serverErrorResponse('Erro ao consultar feedback pendente');
    }
  });
}
