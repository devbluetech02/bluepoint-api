import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Sheet "Controle de entrevista" — fonte canonica de "entrevistas REALIZADAS"
//
// Status no sheet:
//  - REPROVADO      → compareceu, foi reprovado
//  - TESTE          → compareceu, avancou pra teste
//  - NAO COMPARECEU → ausencia (nao conta)
//  - AGENDADO       → marcado, ainda nao realizado
//
// "Realizada" = REPROVADO + TESTE (compareceu de fato).
//
// Reutiliza GOOGLE_SERVICE_ACCOUNT_JSON ja configurado pra drive-video.
// SA precisa ter acesso de leitura ao spreadsheet (ja confirmado).
// ─────────────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = '1oP3MMQgfqlLeFANHorBATZKzKUsZYxP7bQYbXieuNZQ';
const SHEET_TAB = 'Controle de entrevista';
const SHEET_RANGE = `'${SHEET_TAB}'!A1:Z9000`;

// Cache em memoria de processo. TTL curto (60s) porque o sheet e
// atualizado manualmente pelas recrutadoras durante o dia.
let cache: { at: number; data: EntrevistaSheetRow[] } | null = null;
const CACHE_TTL_MS = 60 * 1000;

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
      return null;
    }
    saCache = parsed as ServiceAccount;
    return saCache;
  } catch {
    return null;
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 60) return tokenCache.token;

  const sa = getServiceAccount();
  if (!sa) return null;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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
      console.error(`[sheet-entrevistas] token http_${resp.status}`);
      return null;
    }
    const j = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    tokenCache = {
      token: j.access_token,
      expiresAt: now + (j.expires_in ?? 3600),
    };
    return j.access_token;
  } catch (e) {
    console.error('[sheet-entrevistas] erro buscando token:', e);
    return null;
  }
}

export interface EntrevistaSheetRow {
  recrutador: string;
  entrevistado: string;
  vaga: string;
  filial: string;
  status: string;          // 'REPROVADO' | 'TESTE' | 'NAO COMPARECEU' | 'AGENDADO' | ...
  dataBrtIso: string;      // yyyy-mm-dd no fuso BRT
  realizada: boolean;      // status in (REPROVADO, TESTE)
}

const REALIZADA_STATUSES = new Set(['REPROVADO', 'TESTE']);

/**
 * Converte data formato "DD/MM/YYYY" (com ou sem zero-pad) do sheet
 * em yyyy-mm-dd ISO no fuso BRT.
 */
function parseSheetDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y; // 26 → 2026
  return `${y.padStart(4, '0')}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Fetch + parse do sheet "Controle de entrevista". Cache 60s.
 */
export async function getEntrevistasRealizadas(): Promise<EntrevistaSheetRow[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;

  const token = await getAccessToken();
  if (!token) {
    console.warn('[sheet-entrevistas] sem credenciais GOOGLE_SERVICE_ACCOUNT_JSON — retornando lista vazia');
    return cache?.data ?? [];
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    console.error('[sheet-entrevistas] fetch falhou:', e);
    return cache?.data ?? [];
  }

  if (!resp.ok) {
    console.error(`[sheet-entrevistas] http_${resp.status}: ${await resp.text().catch(() => '')}`);
    return cache?.data ?? [];
  }

  const json = (await resp.json()) as { values?: string[][] };
  const values = json.values ?? [];

  // Linha 0 = espaco branco; linha 1 = header; dados a partir da linha 2.
  const header = values[1] ?? [];
  const idxRec = header.findIndex(h => /recrutador/i.test(h ?? ''));
  const idxEnt = header.findIndex(h => /entrevistado/i.test(h ?? ''));
  const idxVaga = header.findIndex(h => /^vaga$/i.test(h ?? ''));
  const idxFilial = header.findIndex(h => /filial/i.test(h ?? ''));
  const idxStatus = header.findIndex(h => /status/i.test(h ?? ''));
  const idxData = header.findIndex(h => /^data$/i.test(h ?? ''));

  if (idxRec < 0 || idxStatus < 0 || idxData < 0) {
    console.error('[sheet-entrevistas] header inesperado:', header);
    return cache?.data ?? [];
  }

  const out: EntrevistaSheetRow[] = [];
  for (const row of values.slice(2)) {
    const recrutador = (row[idxRec] ?? '').trim();
    const status = (row[idxStatus] ?? '').trim().toUpperCase();
    const dataRaw = (row[idxData] ?? '').trim();
    if (!recrutador || !status || !dataRaw) continue;
    const dataIso = parseSheetDate(dataRaw);
    if (!dataIso) continue;
    out.push({
      recrutador,
      entrevistado: idxEnt >= 0 ? (row[idxEnt] ?? '').trim() : '',
      vaga: idxVaga >= 0 ? (row[idxVaga] ?? '').trim() : '',
      filial: idxFilial >= 0 ? (row[idxFilial] ?? '').trim() : '',
      status,
      dataBrtIso: dataIso,
      realizada: REALIZADA_STATUSES.has(status),
    });
  }

  cache = { at: now, data: out };
  return out;
}
