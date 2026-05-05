/**
 * Verificação de match facial via LLM Vision (camada 2 anti-FP).
 *
 * Quando o ArcFace retorna um match dentro do threshold mas em zona
 * borderline (distância > LLM_VERIFY_THRESHOLD ou gap pequeno entre
 * top-1 e top-2 pessoas), chamamos um modelo de visão pra confirmar
 * em linguagem natural se as duas faces são da mesma pessoa.
 *
 * O modelo recebe a foto capturada agora no totem + a foto de
 * referência cadastrada do colaborador candidato e devolve um JSON
 * com {match, confidence, reason}. Se o modelo discordar do match,
 * o backend rejeita a identificação — mesmo que o vetor ArcFace
 * tenha aprovado.
 *
 * Configurado via OpenRouter (já usado pelo recrutador-IA). Modelo
 * default: gemini 2.0 flash (rápido e bom em vision). Pode ser
 * sobrescrito por env LLM_VISION_MODEL.
 */

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const REQUEST_TIMEOUT_MS = 8_000;

export interface LlmVerifyResult {
  confirmed: boolean;
  confidence: number; // 0..1
  reason: string;
  model: string;
  latencyMs: number;
}

/**
 * Baixa a imagem da URL e devolve um data URI base64.
 * Necessário porque o storage do People exige header de auth público
 * via API Gateway — alguns modelos de vision não conseguem buscar a
 * URL direto. Garantimos que o LLM sempre veja a imagem.
 */
async function urlToDataUri(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) {
      console.warn(`[LLM Verify] Falha ao baixar referência (${resp.status}): ${url}`);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get('content-type') || 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('[LLM Verify] Exceção ao baixar referência:', e);
    return null;
  }
}

function parseLlmJson(raw: string): { match: boolean; confidence: number; reason: string } | null {
  // Modelos às vezes retornam JSON com texto ao redor — extrai o
  // primeiro bloco que parece JSON e tenta parsear.
  const trimmed = raw.trim();
  const candidates: string[] = [];
  // Bloco code fence ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1]);
  // JSON cru no meio do texto
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1));
  }
  candidates.push(trimmed);

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (typeof obj === 'object' && obj !== null) {
        const match = obj.match === true || obj.match === 'true' || obj.same === true;
        const confidence =
          typeof obj.confidence === 'number'
            ? obj.confidence
            : typeof obj.confidence === 'string'
              ? parseFloat(obj.confidence)
              : 0;
        const reason = (obj.reason ?? obj.explanation ?? '').toString();
        return {
          match,
          confidence: isNaN(confidence) ? 0 : Math.max(0, Math.min(1, confidence)),
          reason,
        };
      }
    } catch {
      // tenta o próximo candidato
    }
  }
  return null;
}

/**
 * Compara duas faces via LLM Vision e devolve confirmação textual.
 *
 * Retorna `null` quando a verificação não pôde ser feita (LLM offline,
 * imagem de referência inacessível, modelo retornou JSON inválido).
 * Nesses casos o caller decide se aceita o match do ArcFace ou rejeita.
 */
export async function verificarFacesComLLM(args: {
  capturedDataUri: string;
  referenceUrl: string | null;
  candidatoNome: string;
}): Promise<LlmVerifyResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.LLM_VISION_MODEL || DEFAULT_MODEL;

  if (!apiKey) {
    console.warn('[LLM Verify] OPENROUTER_API_KEY não configurado');
    return null;
  }
  if (!args.referenceUrl) {
    console.warn('[LLM Verify] referenceUrl ausente — pulando verificação');
    return null;
  }

  const refDataUri = await urlToDataUri(args.referenceUrl);
  if (!refDataUri) {
    return null;
  }

  const prompt = `Você está validando reconhecimento facial em um sistema de ponto eletrônico.\n` +
    `Receberá DUAS imagens:\n` +
    `1) Foto capturada agora no totem (rosto da pessoa que está tentando bater ponto).\n` +
    `2) Foto de referência cadastrada do colaborador "${args.candidatoNome}".\n\n` +
    `Sua tarefa: dizer se as duas imagens mostram a MESMA PESSOA. Considere variações ` +
    `naturais (iluminação, ângulo, idade leve, óculos, barba, cabelo, máscara). Seja ` +
    `RIGOROSO — se houver dúvida razoável de que são pessoas diferentes, responda match=false.\n\n` +
    `Responda EXCLUSIVAMENTE em JSON, sem comentários, sem markdown, exatamente neste formato:\n` +
    `{"match": true|false, "confidence": 0.0-1.0, "reason": "explicação curta em português"}`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: args.capturedDataUri },
          },
          {
            type: 'image_url',
            image_url: { url: refDataUri },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 300,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://people-api.valerisapp.com.br',
        'X-Title': 'People — Face Verification',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(`[LLM Verify] HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      return null;
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = parseLlmJson(raw);
    if (!parsed) {
      console.warn('[LLM Verify] JSON inválido na resposta:', raw.slice(0, 300));
      return null;
    }
    const result: LlmVerifyResult = {
      confirmed: parsed.match,
      confidence: parsed.confidence,
      reason: parsed.reason || '',
      model,
      latencyMs: Date.now() - startedAt,
    };
    console.log(
      `[LLM Verify] ${args.candidatoNome}: confirmed=${result.confirmed}, ` +
        `conf=${result.confidence.toFixed(2)}, latency=${result.latencyMs}ms — ${result.reason}`,
    );
    return result;
  } catch (e) {
    console.warn('[LLM Verify] Exceção:', e);
    return null;
  } finally {
    clearTimeout(t);
  }
}
