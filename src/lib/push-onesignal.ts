const APP_TITLES: Record<string, string> = {
  station: 'BluePoint Station',
  'bluepoint-station': 'BluePoint Station',
  mobile: 'BluePoint Mobile',
  'bluepoint-mobile': 'BluePoint Mobile',
};

interface PushVisual {
  android_accent_color: string;
  priority: number;
  emoji: string;
  cor: string;
  big_picture: string;
  large_icon: string;
  uppercase: boolean;
}

export const PUSH_VISUAL: Record<string, PushVisual> = {
  critico: {
    android_accent_color: 'FFDC2626',
    priority: 10,
    emoji: '\u{1F6A8}',
    cor: '#DC2626',
    big_picture: 'https://placehold.co/1280x256/DC2626/FFFFFF/png?text=%F0%9F%9A%A8+ALERTA+CRITICO&font=roboto',
    large_icon: 'https://placehold.co/256x256/DC2626/FFFFFF/png?text=%21&font=roboto',
    uppercase: true,
  },
  atencao: {
    android_accent_color: 'FFF59E0B',
    priority: 7,
    emoji: '\u{26A0}\u{FE0F}',
    cor: '#F59E0B',
    big_picture: 'https://placehold.co/1280x256/F59E0B/000000/png?text=%E2%9A%A0%EF%B8%8F+ATENCAO&font=roboto',
    large_icon: 'https://placehold.co/256x256/F59E0B/000000/png?text=%21&font=roboto',
    uppercase: false,
  },
  info: {
    android_accent_color: 'FF3B82F6',
    priority: 5,
    emoji: '\u{2139}\u{FE0F}',
    cor: '#3B82F6',
    big_picture: 'https://placehold.co/1280x256/3B82F6/FFFFFF/png?text=%E2%84%B9%EF%B8%8F+INFORMATIVO&font=roboto',
    large_icon: 'https://placehold.co/256x256/3B82F6/FFFFFF/png?text=i&font=roboto',
    uppercase: false,
  },
  atualizacao: {
    android_accent_color: 'FF1E40AF',
    priority: 10,
    emoji: '\u{1F4F2}',
    cor: '#1E40AF',
    big_picture: 'https://placehold.co/1280x256/1E40AF/FFFFFF/png?text=%F0%9F%93%B2+NOVA+VERSAO+DISPONIVEL&font=roboto',
    large_icon: 'https://placehold.co/256x256/1E40AF/FFFFFF/png?text=%E2%87%A9&font=roboto',
    uppercase: false,
  },
};

export function buildPushPayload(opts: {
  appId: string;
  headingText: string;
  contentText: string;
  visual: PushVisual;
  data?: Record<string, unknown>;
  url?: string;
}): Record<string, unknown> {
  const rawHeading = opts.visual.emoji + ' ' + opts.headingText;
  const rawContent = opts.contentText;

  const heading = opts.visual.uppercase ? rawHeading.toUpperCase() : rawHeading;
  const content = opts.visual.uppercase ? rawContent.toUpperCase() : rawContent;

  const customIcon = process.env.PUSH_ICON_URL;
  const largeIcon = customIcon || opts.visual.large_icon;

  const payload: Record<string, unknown> = {
    app_id: opts.appId,
    target_channel: 'push',
    headings: { en: heading, pt: heading },
    contents: { en: content, pt: content },
    priority: opts.visual.priority,
    android_accent_color: opts.visual.android_accent_color,
    big_picture: opts.visual.big_picture,
    large_icon: largeIcon,
    chrome_web_image: opts.visual.big_picture,
    chrome_web_icon: customIcon || undefined,
    ...(opts.url ? { url: opts.url } : {}),
    data: {
      cor: opts.visual.cor,
      uppercase: opts.visual.uppercase,
      ...opts.data,
    },
  };

  const smallIcon = process.env.PUSH_SMALL_ICON;
  if (smallIcon) {
    payload.small_icon = smallIcon;
  }

  return payload;
}

export async function sendPush(apiKey: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const resp = await fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + apiKey,
    },
    body: JSON.stringify(payload),
  });
  const body = await resp.json();
  return { ok: resp.ok, status: resp.status, body };
}

/** Nomes dos apps que devem receber push de nova versão (apenas BluePoint Mobile). */
const APPS_COM_PUSH_NOVA_VERSAO = ['mobile', 'bluepoint-mobile'];

export async function enviarPushNovaVersao(nomeApp: string, versao: string, urlDownload: string): Promise<void> {
  if (!APPS_COM_PUSH_NOVA_VERSAO.includes(nomeApp)) {
    console.log('[OneSignal] Push nova versao NAO enviado: app nao elegivel para push de nova versao:', nomeApp);
    return; // Push de nova versão só para BluePoint Mobile; Station não notifica
  }

  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) {
    console.warn('[OneSignal] Push nova versao NAO enviado: ONESIGNAL_APP_ID ou ONESIGNAL_REST_API_KEY nao configurados');
    return;
  }

  const titulo = APP_TITLES[nomeApp] || nomeApp;
  const visual = PUSH_VISUAL.atualizacao;

  try {
    const payload = buildPushPayload({
      appId,
      headingText: 'Nova versao: ' + titulo + ' v' + versao,
      contentText: 'Uma nova versao do ' + titulo + ' esta disponivel. Toque para baixar.',
      visual,
      url: urlDownload,
      data: { tipo: 'nova_versao', app: nomeApp, versao, urlDownload, acao: 'download' },
    });
    payload.included_segments = ['All'];

    const result = await sendPush(apiKey, payload);
    if (!result.ok) {
      console.error('[OneSignal] Erro push nova versao ' + result.status + ':', JSON.stringify(result.body));
    } else {
      console.log('[OneSignal] Push nova versao enviado: ' + titulo + ' v' + versao + ' (id: ' + (result.body as Record<string, string>).id + ')');
    }
  } catch (error) {
    console.error('[OneSignal] Falha push nova versao:', error);
  }
}
