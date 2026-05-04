import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { openRouterChat, extractJson } from '@/lib/openrouter';
import { notificarGestoresRecrutamento } from '@/lib/notificar-gestor-recrutamento';
import {
  normalizarNomeRecrutador,
  SQL_NORMALIZE_NOME,
} from '@/lib/normalizar-nome';

// POST /api/v1/recrutamento/avaliar-recrutador
//
// Gera uma avaliação de performance do recrutador via IA (OpenRouter)
// com base nas últimas N entrevistas com análise IA do banco de
// Recrutamento. Salva resultado em people.recrutador_avaliacao_ia.
//
// Body:
//   { recrutador: string, ultimas?: number (default 5) }
//
// Resposta:
//   { id, recrutador, score, veredito, feedback_recrutador, ... }
//
// Lógica de notificação ao gestor:
//   - Se este resultado for `ruim` E o anterior tb foi `ruim`,
//     marca `notificou_gestor_em` = now() (push real fica
//     a cargo do consumer).

interface PayloadIn {
  recrutador?: string;
  ultimas?: number;
}

interface AnaliseRow {
  entrevista_id: number;
  id_candidatura: number;
  nome_candidato: string | null;
  vaga: string | null;
  data_entrevista: Date | null;
  cobertura: string | null;
  total_aspectos: string | null;
  confirmados: string | null;
  parciais: string | null;
  nao_evidenciados: string | null;
  conclusao: string | null;
  swot_entrevistador: string | null;
}

interface RespostaIA {
  score?: number;
  veredito?: 'bom' | 'regular' | 'ruim';
  feedback_recrutador?: string;
  feedback_gestor?: string;
  pontos_fortes?: string[];
  pontos_fracos?: string[];
}

export async function POST(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const body = (await req.json().catch(() => ({}))) as PayloadIn;
      const recrutador = normalizarNomeRecrutador(body.recrutador ?? '');
      const ultimas = Math.min(Math.max(body.ultimas ?? 5, 1), 20);

      if (!recrutador) {
        return errorResponse('Parâmetro `recrutador` é obrigatório', 400);
      }

      // ── 1) Pega últimas N entrevistas com análise IA do recrutador ──
      // O nome do recrutador pode estar tanto em `entrevistas_agendadas.recrutador`
      // quanto em `candidatos.responsavel_entrevista` — match por OR.
      const analiseRes = await queryRecrutamento<AnaliseRow>(
        `SELECT
           ea.id AS entrevista_id,
           ea.id_candidatura,
           c.nome AS nome_candidato,
           c.vaga,
           ea.data_entrevista,
           (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'cobertura_percent') AS cobertura,
           (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'total_aspectos') AS total_aspectos,
           (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'confirmados') AS confirmados,
           (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'parciais') AS parciais,
           (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'nao_evidenciados') AS nao_evidenciados,
           (ea.analise::jsonb ->> 'conclusao') AS conclusao,
           (ea.analise::jsonb -> 'swot_entrevistador')::text AS swot_entrevistador
         FROM public.entrevistas_agendadas ea
         LEFT JOIN public.candidatos c ON c.id = ea.id_candidatura
         WHERE ea.analise IS NOT NULL
           AND TRIM(ea.analise) <> ''
           AND (
             ${SQL_NORMALIZE_NOME('ea.recrutador')} = $1
             OR ${SQL_NORMALIZE_NOME('c.responsavel_entrevista')} = $1
           )
         ORDER BY ea.data_entrevista DESC NULLS LAST, ea.id DESC
         LIMIT $2`,
        [recrutador, ultimas]
      );

      const entrevistas = analiseRes.rows;
      if (entrevistas.length === 0) {
        return errorResponse(
          `Nenhuma entrevista com análise IA encontrada pra recrutador "${recrutador}".`,
          404
        );
      }

      // ── 2) Resumir cada entrevista pra prompt enxuto ──
      // O driver pg da base de Recrutamento entrega timestamp como string;
      // converte uma vez pra Date pra evitar `.toISOString is not a function`.
      const toDate = (v: Date | string | null | undefined): Date | null => {
        if (!v) return null;
        if (v instanceof Date) return v;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      };

      const resumos = entrevistas.map((e, i) => {
        const d = toDate(e.data_entrevista);
        const data = d ? d.toISOString().slice(0, 10) : '?';
        return [
          `[Entrevista ${i + 1}] data=${data} candidato="${e.nome_candidato ?? '?'}" vaga="${e.vaga ?? '?'}"`,
          `  cobertura_percent=${e.cobertura ?? '?'}`,
          `  total_aspectos=${e.total_aspectos ?? '?'} confirmados=${e.confirmados ?? '?'} parciais=${e.parciais ?? '?'} nao_evidenciados=${e.nao_evidenciados ?? '?'}`,
          `  conclusao=${(e.conclusao ?? '').slice(0, 600)}`,
          `  swot_entrevistador=${(e.swot_entrevistador ?? '').slice(0, 800)}`,
        ].join('\n');
      });

      const dDe = toDate(entrevistas[entrevistas.length - 1].data_entrevista);
      const dAte = toDate(entrevistas[0].data_entrevista);
      const periodoDe = dDe
        ? dDe.toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      const periodoAte = dAte
        ? dAte.toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      // ── 3) Prompt pra IA ──
      const systemPrompt = `Você é um avaliador sênior de recrutadores corporativos. Sua tarefa é, com base em análises agregadas das últimas entrevistas conduzidas por um recrutador, gerar um diagnóstico curto e acionável.

Critérios de avaliação:
- Profundidade das perguntas (foi além do roteiro? sondou inconsistências?)
- Cobertura dos aspectos do CV (cobertura_percent e nao_evidenciados são bons indicadores)
- Qualidade da condução (SWOT entrevistador)
- Consistência entre entrevistas

Responda APENAS com JSON válido neste formato exato:
{
  "score": <int 0-100>,
  "veredito": "bom" | "regular" | "ruim",
  "feedback_recrutador": "<2-4 frases curtas, tom direto, sem floreio. Se 'bom': elogie pontos concretos e diga que o gestor será informado. Se 'regular': aponte 1-2 ajustes específicos. Se 'ruim': diga que detectou inconsistências, liste o que precisa melhorar e avise que se não melhorar o gestor será contatado.>",
  "feedback_gestor": "<resumo executivo 2-3 frases. NULL se veredito='bom'.>",
  "pontos_fortes": ["...", "..."],
  "pontos_fracos": ["...", "..."]
}

Thresholds:
- score >= 80: bom
- 60 <= score < 80: regular
- score < 60: ruim`;

      const userPrompt = [
        `Recrutador: ${recrutador}`,
        `Período: ${periodoDe} → ${periodoAte}`,
        `Quantidade de entrevistas analisadas: ${entrevistas.length}`,
        '',
        'Resumo de cada entrevista:',
        ...resumos,
      ].join('\n');

      // ── 4) Chamada OpenRouter ──
      const r = await openRouterChat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          temperature: 0.3,
          maxTokens: 1500,
          responseFormatJson: true,
          timeoutMs: 90_000,
        }
      );

      if (!r.ok) {
        return errorResponse(`Falha na IA: ${r.reason}`, 502);
      }

      const parsed = extractJson<RespostaIA>(r.content);
      if (!parsed) {
        return errorResponse(
          'Resposta da IA não é JSON válido',
          502
        );
      }

      const score = Math.max(0, Math.min(100, parsed.score ?? 0));
      const veredito =
        parsed.veredito === 'bom' ||
        parsed.veredito === 'regular' ||
        parsed.veredito === 'ruim'
          ? parsed.veredito
          : score >= 80
            ? 'bom'
            : score >= 60
              ? 'regular'
              : 'ruim';
      const feedbackRecrutador = (parsed.feedback_recrutador ?? '').trim();
      const feedbackGestor = (parsed.feedback_gestor ?? '').trim() || null;
      const pontosFortes = Array.isArray(parsed.pontos_fortes)
        ? parsed.pontos_fortes.slice(0, 8)
        : [];
      const pontosFracos = Array.isArray(parsed.pontos_fracos)
        ? parsed.pontos_fracos.slice(0, 8)
        : [];

      if (!feedbackRecrutador) {
        return errorResponse('IA não devolveu feedback ao recrutador', 502);
      }

      // ── 5) Verifica se a anterior também foi 'ruim' ──
      // Cooldown: só notifica se a anterior foi 'ruim' E ainda não havia
      // notificado (evita spam quando o recrutador segue 'ruim' por vários
      // ciclos seguidos — só dispara push uma vez até a sequência quebrar).
      let notificarGestor: Date | null = null;
      if (veredito === 'ruim') {
        const anteriorRes = await query<{
          veredito: string;
          notificou_gestor_em: Date | null;
        }>(
          `SELECT veredito, notificou_gestor_em FROM people.recrutador_avaliacao_ia
            WHERE recrutador_nome = $1
            ORDER BY criado_em DESC
            LIMIT 1`,
          [recrutador]
        );
        const anterior = anteriorRes.rows[0];
        if (
          anterior?.veredito === 'ruim' &&
          anterior.notificou_gestor_em == null
        ) {
          notificarGestor = new Date();
        }
      }

      // ── 6) Persistir ──
      const insertRes = await query<{ id: string; criado_em: Date }>(
        `INSERT INTO people.recrutador_avaliacao_ia (
           recrutador_nome, periodo_de, periodo_ate, entrevistas_avaliadas,
           score, veredito, feedback_recrutador, feedback_gestor,
           pontos_fortes, pontos_fracos, modelo_ia, notificou_gestor_em
         ) VALUES (
           $1, $2::date, $3::date, $4, $5, $6, $7, $8,
           $9::jsonb, $10::jsonb, $11, $12
         )
         RETURNING id::text, criado_em`,
        [
          recrutador,
          periodoDe,
          periodoAte,
          entrevistas.length,
          score,
          veredito,
          feedbackRecrutador,
          feedbackGestor,
          JSON.stringify(pontosFortes),
          JSON.stringify(pontosFracos),
          r.model,
          notificarGestor,
        ]
      );

      const inserted = insertRes.rows[0];

      // Dispara push pros gestores se notificarGestor foi acionado.
      if (notificarGestor != null) {
        await notificarGestoresRecrutamento({
          recrutador,
          score,
          feedbackGestor,
          avaliacaoId: inserted.id,
        });
      }

      return successResponse({
        id: inserted.id,
        recrutador,
        periodoDe,
        periodoAte,
        entrevistasAvaliadas: entrevistas.length,
        score,
        veredito,
        feedbackRecrutador,
        feedbackGestor,
        pontosFortes,
        pontosFracos,
        modelo: r.model,
        notificarGestor: notificarGestor != null,
        criadoEm: inserted.criado_em,
      });
    } catch (error) {
      console.error('[recrutamento/avaliar-recrutador] erro:', error);
      return serverErrorResponse('Erro ao avaliar recrutador');
    }
  });
}
