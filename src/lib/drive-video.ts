import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Drive video metadata
//
// Le a duracao (em segundos) de um arquivo de video no Google Drive usando
// service account (ENV GOOGLE_SERVICE_ACCOUNT_JSON). Nao baixa o arquivo;
// usa o endpoint files.get com `fields=videoMediaMetadata`, que retorna
// `durationMillis` direto.
//
// Setup:
//  - ENV GOOGLE_SERVICE_ACCOUNT_JSON: JSON inteiro do service account
//  - SA precisa ter acesso de leitura aos arquivos no Drive (Drive web →
//    pasta com vídeos → Compartilhar → cola client_email do SA)
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

let saCache: ServiceAccount | null = null;
let tokenCache: { token: string; expiresAt: number } | null = null;

function getServiceAccount(): ServiceAccount | null {
  if (saCache) return saCache;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.client_email || !parsed.private_key || !parsed.token_uri) {
      console.warn('[drive-video] GOOGLE_SERVICE_ACCOUNT_JSON sem campos obrigatorios');
      return null;
    }
    saCache = parsed as ServiceAccount;
    return saCache;
  } catch (e) {
    console.error('[drive-video] GOOGLE_SERVICE_ACCOUNT_JSON parse falhou:', e);
    return null;
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken(): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 60) return tokenCache.token;

  const sa = getServiceAccount();
  if (!sa) return null;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signInput = `${header}.${payload}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signInput)
    .sign(sa.private_key);
  const jwt = `${signInput}.${b64url(signature)}`;

  try {
    const resp = await fetch(sa.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });
    if (!resp.ok) {
      console.error(`[drive-video] token http_${resp.status}: ${await resp.text().catch(() => '')}`);
      return null;
    }
    const j = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) {
      console.error('[drive-video] resposta sem access_token:', j);
      return null;
    }
    tokenCache = {
      token: j.access_token,
      expiresAt: now + (j.expires_in ?? 3600),
    };
    return j.access_token;
  } catch (e) {
    console.error('[drive-video] erro buscando token:', e);
    return null;
  }
}

interface DriveVideoMeta {
  durationMillis?: string;
  width?: number;
  height?: number;
}

interface DriveFileResp {
  id?: string;
  name?: string;
  size?: string;
  mimeType?: string;
  createdTime?: string;
  videoMediaMetadata?: DriveVideoMeta;
  error?: { code?: number; message?: string };
}

export interface DurationResult {
  ok: boolean;
  duracaoSegundos?: number;
  erro?: string;
}

export interface CreatedTimeResult {
  ok: boolean;
  createdTime?: Date;
  erro?: string;
}

/**
 * Retorna duracao (em segundos inteiros) do video no Drive. Cache do
 * access_token reutilizado por 1h.
 */
export async function getVideoDurationSeconds(
  videoId: string,
): Promise<DurationResult> {
  if (!videoId || videoId.trim() === '') {
    return { ok: false, erro: 'video_id_vazio' };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, erro: 'sem_credenciais' };

  try {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(videoId)}?fields=id,videoMediaMetadata,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await resp.json()) as DriveFileResp;
    if (!resp.ok) {
      return {
        ok: false,
        erro: `http_${resp.status}: ${data?.error?.message ?? ''}`.slice(0, 200),
      };
    }
    const ms = data.videoMediaMetadata?.durationMillis;
    if (!ms) return { ok: false, erro: 'sem_videoMediaMetadata' };
    const segundos = Math.round(parseInt(ms, 10) / 1000);
    if (!Number.isFinite(segundos) || segundos <= 0) {
      return { ok: false, erro: `duracao_invalida_${ms}` };
    }
    return { ok: true, duracaoSegundos: segundos };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

/**
 * Retorna o `createdTime` do arquivo no Drive (momento em que foi
 * salvo). Para vídeos de entrevista, isso corresponde ao fim do
 * recording — útil pra calcular tempo ocioso entre entrevistas.
 * Cache do access_token reutilizado por 1h.
 */
export async function getVideoCreatedTime(
  videoId: string,
): Promise<CreatedTimeResult> {
  if (!videoId || videoId.trim() === '') {
    return { ok: false, erro: 'video_id_vazio' };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, erro: 'sem_credenciais' };

  try {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(videoId)}?fields=id,createdTime&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await resp.json()) as DriveFileResp;
    if (!resp.ok) {
      return {
        ok: false,
        erro: `http_${resp.status}: ${data?.error?.message ?? ''}`.slice(0, 200),
      };
    }
    if (!data.createdTime) return { ok: false, erro: 'sem_createdTime' };
    const dt = new Date(data.createdTime);
    if (isNaN(dt.getTime())) {
      return { ok: false, erro: `createdTime_invalido_${data.createdTime}` };
    }
    return { ok: true, createdTime: dt };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}
