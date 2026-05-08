import { openRouterChat } from './openrouter';

// ─────────────────────────────────────────────────────────────────────────────
// Aderencia da entrevista ao roteiro IA
//
// Compara transcricao real da entrevista com:
//   - roteiro_entrevista.info_roteiro_text  (perguntas/temas sugeridos
//     pela IA pra aquela vaga)
//
// LLM retorna pct 0-100 (% de topicos abordados), lista dos abordados,
// lista dos ausentes e resumo curto.
// ─────────────────────────────────────────────────────────────────────────────

export interface AderenciaResultado {
  ok: true;
  pct: number;
  topicos: {
    abordados: string[];
    ausentes: string[];
    resumo: string;
  };
}

export interface AderenciaFalha {
  ok: false;
  motivo: string;
}

export type AderenciaResposta = AderenciaResultado | AderenciaFalha;

const SYSTEM = `Você analisa transcrições de entrevistas de RH e mede aderência ao roteiro sugerido pela IA.

Receberá:
  1) Roteiro: tópicos/perguntas que a IA sugeriu ao recrutador antes da entrevista.
  2) Transcrição: o que de fato foi falado na entrevista.

Sua resposta DEVE ser JSON estrito (sem texto fora do JSON), no formato:
{
  "pct": <numero 0-100>,
  "abordados": [<topicos do roteiro mencionados/explorados pelo recrutador>],
  "ausentes": [<topicos do roteiro NAO abordados ou tratados de forma muito superficial>],
  "resumo": "<1-2 frases sobre como o recrutador conduziu a entrevista frente ao roteiro>"
}

Regras:
- "pct" reflete a proporção de tópicos do roteiro abordados de forma minimamente aprofundada (não basta citar de passagem).
- Se o roteiro estiver vazio ou irrelevante, retorne pct=0 e resumo explicando.
- Liste cada tópico em PORTUGUÊS, curto (≤60 chars).`;

export async function avaliarAderencia(args: {
  roteiro: string;
  transcricao: string;
  vaga?: string | null;
  modelo?: string;
}): Promise<AderenciaResposta> {
  const roteiro = args.roteiro?.trim() ?? '';
  const transcricao = args.transcricao?.trim() ?? '';

  if (!roteiro || roteiro.length < 30) {
    return { ok: false, motivo: 'roteiro_vazio_ou_curto' };
  }
  if (!transcricao || transcricao.length < 200) {
    return { ok: false, motivo: 'transcricao_vazia_ou_curta' };
  }

  // Limita tamanho pra controlar custo (Claude Sonnet ~ $3/MTok input).
  // 60k chars ≈ 15k tokens — suficiente pra entrevistas de até ~30 min
  // de transcrição. Se vier mais, trunca o final (último trecho).
  const MAX = 60_000;
  const txTrunc = transcricao.length > MAX ? transcricao.slice(0, MAX) : transcricao;

  const userMsg = [
    `VAGA: ${args.vaga ?? '(não informada)'}`,
    ``,
    `--- ROTEIRO SUGERIDO PELA IA ---`,
    roteiro,
    ``,
    `--- TRANSCRIÇÃO DA ENTREVISTA ---`,
    txTrunc,
  ].join('\n');

  const r = await openRouterChat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userMsg },
    ],
    {
      model: args.modelo,
      temperature: 0.1,
      maxTokens: 1500,
      responseFormatJson: true,
      timeoutMs: 90_000,
    },
  );

  if (!r.ok) {
    return { ok: false, motivo: `llm_falhou: ${r.reason}` };
  }

  // Tenta parsear JSON. Modelos as vezes retornam texto antes/depois.
  const raw = r.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { ok: false, motivo: 'resposta_sem_json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { ok: false, motivo: `json_invalido: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, motivo: 'json_nao_objeto' };
  }
  const obj = parsed as Record<string, unknown>;
  const pctRaw = obj.pct;
  const pct = typeof pctRaw === 'number' ? pctRaw : Number(pctRaw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, motivo: 'pct_invalido' };
  }
  const abordados = Array.isArray(obj.abordados)
    ? (obj.abordados as unknown[]).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 30)
    : [];
  const ausentes = Array.isArray(obj.ausentes)
    ? (obj.ausentes as unknown[]).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 30)
    : [];
  const resumo = typeof obj.resumo === 'string' ? obj.resumo.slice(0, 1000) : '';

  return {
    ok: true,
    pct: Math.round(pct * 100) / 100,
    topicos: { abordados, ausentes, resumo },
  };
}
