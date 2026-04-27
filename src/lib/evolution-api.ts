/**
 * Evolution API — envio de mensagens WhatsApp
 * Variáveis de ambiente necessárias:
 *   EVOLUTION_API_URL       ex: https://evolution.example.com
 *   EVOLUTION_API_KEY       chave de autenticação
 *   EVOLUTION_INSTANCE      nome da instância
 */

export interface EvolutionResult {
  ok: boolean;
  erro?: string;
}

export async function enviarMensagemWhatsApp(
  numero: string,
  texto: string,
): Promise<EvolutionResult> {
  const url      = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;

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
      console.error(`[Evolution API] Erro ${response.status}: ${body}`);
      return { ok: false, erro: `http_${response.status}` };
    }

    console.log(`[Evolution API] Mensagem enviada para ${numero}`);
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
): Promise<EvolutionResult> {
  const url      = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;

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
      console.error(`[Evolution API] Erro ao enviar mídia ${response.status}: ${respBody}`);
      return { ok: false, erro: `http_${response.status}` };
    }

    console.log(`[Evolution API] Mídia (${mediatype}) enviada para ${numero}`);
    return { ok: true };
  } catch (error) {
    console.error('[Evolution API] Falha ao enviar mídia:', error);
    return { ok: false, erro: 'exception' };
  }
}
