/**
 * Converte variáveis de imagem (URL) em data URI base64 antes de mandar pro
 * SignProof.
 *
 * Por que: o template SignProof renderiza o valor da variável como texto
 * cru — uma URL crua aparece como string no PDF, não como imagem. Para
 * embutir a imagem de fato, é preciso enviar `data:image/<tipo>;base64,...`.
 * Empiricamente verificado em 2026-04-28 contra o template
 * `contrato_experiencia_v1`: PDF gerado com URL ficou ~5 bytes maior que sem
 * variável; com data URI base64 cresceu ~4 KB (peso da imagem embutida).
 */

const IMAGE_FIELD_RE = /^(foto_|logo_|imagem_)|(_imagem|_image)$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — proteção contra payload absurdo

const FETCH_TIMEOUT_MS = 10_000;

/** Tenta detectar o content-type a partir da extensão da URL como fallback. */
function contentTypeFromUrl(url: string): string {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

function isImageField(name: string): boolean {
  return IMAGE_FIELD_RE.test(name);
}

function isHttpUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('http://') || value.startsWith('https://'))
  );
}

async function urlToDataUri(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      console.warn(`[signproof-image] fetch ${resp.status} for ${url}`);
      return null;
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 0) return null;
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      console.warn(
        `[signproof-image] imagem ${url} excede ${MAX_IMAGE_BYTES} bytes (${buf.byteLength}); ignorando`,
      );
      return null;
    }
    const ct = resp.headers.get('content-type')?.split(';')[0]?.trim()
      || contentTypeFromUrl(url);
    const base64 = Buffer.from(buf).toString('base64');
    return `data:${ct};base64,${base64}`;
  } catch (err) {
    console.warn(`[signproof-image] falha ao baixar ${url}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Para cada chave em [variables] que pareça campo de imagem (`foto_*`,
 * `logo_*`, `imagem_*`, `*_imagem`, `*_image`) e cujo valor seja URL HTTP(S),
 * baixa o arquivo e substitui pelo data URI base64. Mutações são feitas no
 * próprio objeto. Em caso de erro mantém o valor original (URL) — isso degrada
 * pra "imagem aparece como texto" ao invés de quebrar a geração do contrato.
 */
export async function resolveImageVariables(
  variables: Record<string, unknown> | undefined,
): Promise<void> {
  if (!variables || typeof variables !== 'object') return;
  const tasks: Promise<void>[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (!isImageField(key) || !isHttpUrl(value)) continue;
    tasks.push(
      urlToDataUri(value).then((dataUri) => {
        if (dataUri) variables[key] = dataUri;
      }),
    );
  }
  if (tasks.length > 0) await Promise.all(tasks);
}
