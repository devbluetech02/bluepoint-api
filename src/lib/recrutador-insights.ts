import crypto from 'node:crypto';

import { openRouterChat } from './openrouter';
import { cacheGet, cacheSet, CACHE_TTL } from './cache';

// ─────────────────────────────────────────────────────────────────────────────
// Insights LLM por recrutador
//
// Gera 2-4 bullets em PT-BR sobre o que o recrutador precisa melhorar,
// baseado em metricas agregadas dos 3 periodos vs media da equipe.
//
// Cache TTL longo (30min) — metricas mudam devagar e LLM e caro.
// fire-and-forget: chamador usa fallback rule-based se nao tiver cache;
// LLM popula cache em background pra proxima carga.
// ─────────────────────────────────────────────────────────────────────────────

interface PeriodoStats {
  total: number;
  diasComEntrevista: number;
  mediaPorDia: number;
  mediaDuracaoSeg: number;
  mediaGapSeg: number | null;
  validas: number;
  taxaValidasPct: number;
  mediaAderenciaPct: number | null;
}

export interface GerarInsightsArgs {
  nome: string;
  hoje: PeriodoStats;
  sete: PeriodoStats;
  trinta: PeriodoStats;
  equipe: PeriodoStats; // 30d
  duracaoMinMin: number;
}

const SYSTEM = `Você é um head de recrutamento que entrega feedback objetivo, em PT-BR, baseado em métricas reais.

Receberá métricas de 1 recrutador em 3 períodos (hoje, 7 dias, 30 dias) + média da equipe (30d) + duração mínima esperada de entrevista (em minutos).

Sua resposta DEVE ser JSON estrito, no formato:
{
  "pontos": ["<bullet 1>", "<bullet 2>", "<bullet 3>"]
}

Regras:
- 2 a 4 bullets, no máximo. Se está tudo dentro do esperado, retorne 1 bullet positivo curto.
- Cada bullet ≤ 140 caracteres.
- Compare com a média da equipe quando relevante.
- Cite números concretos (ex.: "duração 4min vs alvo 7,5min").
- NÃO comece com "O recrutador" — fale direto ("Volume baixo...", "Duração curta...").
- Foque em AÇÃO, não diagnóstico vazio.
- Sem emoji, sem hashtag.`;

function hashMetrics(args: GerarInsightsArgs): string {
  const round1 = (n: number | null | undefined) =>
    n == null ? null : Math.round(n * 10) / 10;
  const sliced = {
    n: args.nome,
    dmm: args.duracaoMinMin,
    h: { t: args.hoje.total, mpd: round1(args.hoje.mediaPorDia) },
    s: {
      t: args.sete.total,
      mpd: round1(args.sete.mediaPorDia),
      md: args.sete.mediaDuracaoSeg,
      tv: round1(args.sete.taxaValidasPct),
    },
    t: {
      t: args.trinta.total,
      mpd: round1(args.trinta.mediaPorDia),
      md: args.trinta.mediaDuracaoSeg,
      tv: round1(args.trinta.taxaValidasPct),
      ad: round1(args.trinta.mediaAderenciaPct),
      gap: args.trinta.mediaGapSeg,
    },
    e: {
      t: args.equipe.total,
      mpd: round1(args.equipe.mediaPorDia),
      md: args.equipe.mediaDuracaoSeg,
      tv: round1(args.equipe.taxaValidasPct),
      ad: round1(args.equipe.mediaAderenciaPct),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(sliced)).digest('hex').slice(0, 16);
}

function cacheKey(args: GerarInsightsArgs): string {
  return `recrutador-insights:v1:${hashMetrics(args)}`;
}

/**
 * Tenta ler insights do cache. Retorna null se nao houver — chamador
 * deve usar fallback rule-based.
 */
export async function lerInsightsCacheado(
  args: GerarInsightsArgs,
): Promise<string[] | null> {
  const k = cacheKey(args);
  const v = await cacheGet<string[]>(k);
  return v ?? null;
}

/**
 * Roda LLM e grava no cache. Fire-and-forget no chamador.
 */
export async function gerarInsightsViaLLM(
  args: GerarInsightsArgs,
): Promise<string[] | null> {
  const userMsg = [
    `Recrutador: ${args.nome}`,
    `Duração mínima esperada: ${args.duracaoMinMin} min`,
    ``,
    `HOJE — total ${args.hoje.total}, média/dia ${args.hoje.mediaPorDia.toFixed(1)}.`,
    `7 DIAS — total ${args.sete.total}, média/dia ${args.sete.mediaPorDia.toFixed(1)}, duração média ${Math.round(args.sete.mediaDuracaoSeg / 60)}min, % válidas ${args.sete.taxaValidasPct.toFixed(0)}%.`,
    `30 DIAS — total ${args.trinta.total}, média/dia ${args.trinta.mediaPorDia.toFixed(1)}, duração média ${Math.round(args.trinta.mediaDuracaoSeg / 60)}min, % válidas ${args.trinta.taxaValidasPct.toFixed(0)}%, aderência IA ${args.trinta.mediaAderenciaPct?.toFixed(0) ?? '—'}%, gap médio ${args.trinta.mediaGapSeg != null ? Math.round(args.trinta.mediaGapSeg / 60) + 'min' : '—'}.`,
    ``,
    `EQUIPE (30d, base de comparação) — total ${args.equipe.total}, média/dia ${args.equipe.mediaPorDia.toFixed(1)}, duração média ${Math.round(args.equipe.mediaDuracaoSeg / 60)}min, % válidas ${args.equipe.taxaValidasPct.toFixed(0)}%, aderência IA ${args.equipe.mediaAderenciaPct?.toFixed(0) ?? '—'}%.`,
  ].join('\n');

  const r = await openRouterChat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userMsg },
    ],
    {
      temperature: 0.3,
      maxTokens: 600,
      responseFormatJson: true,
      timeoutMs: 60_000,
    },
  );
  if (!r.ok) {
    console.warn(`[recrutador-insights] LLM falhou: ${r.reason}`);
    return null;
  }
  const raw = r.content.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { pontos?: unknown };
    if (!Array.isArray(parsed.pontos)) return null;
    const pontos = parsed.pontos
      .map((x) => String(x).trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 5);
    if (pontos.length === 0) return null;
    await cacheSet(cacheKey(args), pontos, CACHE_TTL.LONG ?? 1800);
    return pontos;
  } catch {
    return null;
  }
}

/**
 * Dispara geracao em background sem bloquear o response.
 */
export function dispararGeracaoEmBackground(args: GerarInsightsArgs): void {
  // Best-effort. Se falhar nao loga stack ruidoso.
  gerarInsightsViaLLM(args).catch(() => {
    // silencioso
  });
}
