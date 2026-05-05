/**
 * Evolution API — envio de mensagens WhatsApp
 *
 * Variáveis de ambiente padrão (instância principal):
 *   EVOLUTION_API_URL       ex: https://wa-api.bluetechfilms.com.br
 *   EVOLUTION_API_KEY       chave de autenticação
 *   EVOLUTION_INSTANCE      nome da instância (ex.: PEOPLE)
 *
 * Instância de recrutamento (Dia de Teste — separada do canal People
 * pra não misturar tráfego comercial/RH):
 *   EVOLUTION_INSTANCE_RECRUTAMENTO   ex.: RH_ROBSON
 *   EVOLUTION_API_KEY_RECRUTAMENTO    apikey específica daquela instância
 *   EVOLUTION_API_URL_RECRUTAMENTO    opcional — fallback p/ EVOLUTION_API_URL
 *
 * Pré-admissão e demais fluxos seguem usando a instância padrão.
 */

export interface EvolutionConfig {
  url?: string;
  apiKey?: string;
  instance?: string;
}

export interface EvolutionResult {
  ok: boolean;
  erro?: string;
}

function resolveConfig(override?: EvolutionConfig) {
  return {
    url: override?.url ?? process.env.EVOLUTION_API_URL,
    apiKey: override?.apiKey ?? process.env.EVOLUTION_API_KEY,
    instance: override?.instance ?? process.env.EVOLUTION_INSTANCE,
  };
}

/**
 * Config da instância dedicada ao recrutamento (mensagens de Dia de Teste).
 * Sempre cai pra instância padrão se as envs específicas não estiverem
 * configuradas — comportamento defensivo pra não bloquear envio.
 */
export function getRecrutamentoEvolutionConfig(): EvolutionConfig {
  return {
    url: process.env.EVOLUTION_API_URL_RECRUTAMENTO ?? process.env.EVOLUTION_API_URL,
    apiKey: process.env.EVOLUTION_API_KEY_RECRUTAMENTO ?? process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE_RECRUTAMENTO ?? process.env.EVOLUTION_INSTANCE,
  };
}

export async function enviarMensagemWhatsApp(
  numero: string,
  texto: string,
  config?: EvolutionConfig,
): Promise<EvolutionResult> {
  const { url, apiKey, instance } = resolveConfig(config);

  if (!url || !apiKey || !instance) {
    console.warn('[Evolution API] Variáveis EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE não configuradas');
    return { ok: false, erro: 'evolution_nao_configurada' };
  }

  try {
    // Normaliza número brasileiro para formato E.164 (55 + DDD 2 dígitos + 9 dígitos)
    let digits = numero.replace(/\D/g, '');
    if (digits.startsWith('55')) digits = digits.slice(2); // remove DDI
    if (digits.length === 10) digits = digits.slice(0, 2) + '9' + digits.slice(2); // adiciona 9 após DDD
    const numeroFormatado = `55${digits}`;

    const endpoint = `${url.replace(/\/$/, '')}/message/sendText/${instance}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey,
      },
      body: JSON.stringify({ number: numeroFormatado, text: texto }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[Evolution API] Erro ${response.status} (instance=${instance}): ${body}`);
      return { ok: false, erro: `http_${response.status}` };
    }

    console.log(`[Evolution API] Mensagem enviada para ${numero} via ${instance}`);
    return { ok: true };
  } catch (error) {
    console.error('[Evolution API] Falha ao enviar mensagem:', error);
    return { ok: false, erro: 'exception' };
  }
}

/**
 * Envia uma mídia (vídeo, imagem ou documento) com legenda opcional.
 *
 * `mediaUrl` precisa ser uma URL HTTP/HTTPS pública — a Evolution baixa o
 * arquivo direto da fonte. Para vídeo, manter abaixo de 16 MB (limite do
 * WhatsApp via API). Falha graciosamente se a Evolution não estiver
 * configurada.
 */
export async function enviarMidiaWhatsApp(
  numero: string,
  mediaUrl: string,
  options: {
    mediatype?: 'image' | 'video' | 'document';
    caption?: string;
    fileName?: string;
    mimetype?: string;
  } = {},
  config?: EvolutionConfig,
): Promise<EvolutionResult> {
  const { url, apiKey, instance } = resolveConfig(config);

  if (!url || !apiKey || !instance) {
    console.warn('[Evolution API] Variáveis não configuradas para envio de mídia');
    return { ok: false, erro: 'evolution_nao_configurada' };
  }

  try {
    let digits = numero.replace(/\D/g, '');
    if (digits.startsWith('55')) digits = digits.slice(2);
    if (digits.length === 10) digits = digits.slice(0, 2) + '9' + digits.slice(2);
    const numeroFormatado = `55${digits}`;

    const mediatype = options.mediatype ?? 'video';
    const mimetype = options.mimetype ?? (mediatype === 'video' ? 'video/mp4' : undefined);
    const fileName = options.fileName ?? mediaUrl.split('/').pop() ?? 'arquivo';

    const endpoint = `${url.replace(/\/$/, '')}/message/sendMedia/${instance}`;
    const body: Record<string, unknown> = {
      number: numeroFormatado,
      mediatype,
      media: mediaUrl,
      fileName,
    };
    if (options.caption) body.caption = options.caption;
    if (mimetype) body.mimetype = mimetype;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const respBody = await response.text().catch(() => '');
      console.error(`[Evolution API] Erro ao enviar mídia ${response.status} (instance=${instance}): ${respBody}`);
      return { ok: false, erro: `http_${response.status}` };
    }

    console.log(`[Evolution API] Mídia (${mediatype}) enviada para ${numero} via ${instance}`);
    return { ok: true };
  } catch (error) {
    console.error('[Evolution API] Falha ao enviar mídia:', error);
    return { ok: false, erro: 'exception' };
  }
}
