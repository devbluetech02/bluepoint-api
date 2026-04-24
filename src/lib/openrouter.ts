/**
 * Wrapper minimal do endpoint OpenRouter (OpenAI-compat chat completions).
 *
 * Env (aceita ambos os nomes — OpenRouter é compatível OpenAI SDK):
 *  - OPENROUTER_API_KEY ou OPENAI_API_KEY (um dos dois obrigatório)
 *  - OPENROUTER_MODEL ou OPENAI_MODEL (default: anthropic/claude-sonnet-4.5)
 *  - OPENROUTER_REFERRER (opcional; site que aparece no painel da OpenRouter)
 *
 * Nunca lança — retorna { ok: false, reason } em erro pra chamador tratar.
 */

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenRouterResult {
  ok: true;
  model: string;
  content: string;
  usage: OpenRouterUsage;
  raw: unknown;
}

export interface OpenRouterFailure {
  ok: false;
  reason: string;
  status?: number;
}

export async function openRouterChat(
  messages: OpenRouterMessage[],
  opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormatJson?: boolean;
    timeoutMs?: number;
  },
): Promise<OpenRouterResult | OpenRouterFailure> {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: 'openrouter_key_ausente' };

  const model = opts?.model
    ?? process.env.OPENROUTER_MODEL
    ?? process.env.OPENAI_MODEL
    ?? 'anthropic/claude-sonnet-4.5';

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts?.temperature ?? 0.2,
  };
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts?.responseFormatJson) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_REFERRER ?? 'https://people-api.valerisapp.com.br',
        'X-Title': 'BluePoint People — IA Pré-admissão',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, reason: `http_${resp.status}: ${text.slice(0, 200)}`, status: resp.status };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'json_parse_falhou' };
    }

    const raw = parsed as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: OpenRouterUsage;
    };
    const content = raw.choices?.[0]?.message?.content ?? '';
    if (!content) return { ok: false, reason: 'content_vazio' };

    return {
      ok: true,
      model: raw.model ?? model,
      content,
      usage: raw.usage ?? {},
      raw: parsed,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: `excecao: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrai o primeiro bloco JSON válido da resposta do modelo. Modelos LLM às
 * vezes embrulham em ```json ... ``` ou adicionam texto antes/depois. Usamos
 * a resposta crua + algumas heurísticas pra ser robusto.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  const trimmed = raw.trim();
  // Tentativa direta
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // continua
  }

  // Bloco markdown ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as T;
    } catch {
      // continua
    }
  }

  // Primeiro { ... } balanceado
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1)) as T;
    } catch {
      // continua
    }
  }

  return null;
}
