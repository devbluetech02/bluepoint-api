/**
 * Wrapper HTTP da API Sicoob PIX (https://pix-sicoob-recebimento.bluetechfilms.com.br).
 *
 * Variaveis de ambiente:
 *   PIX_API_URL = base URL (ex: https://pix-sicoob-recebimento.bluetechfilms.com.br)
 *   PIX_API_KEY = chave passada em header `Authorization`
 *
 * Fluxo de pagamento de saida (gestor pagando candidato):
 *   1. iniciar({chave, idempotencyKey}) -> {endToEndId, dadosBeneficiario...}
 *   2. confirmar({endToEndId, valor, descricao, idempotencyKey}) -> {status...}
 *   3. consultar(endToEndId) -> snapshot do estado atual.
 *
 * Sicoob aceita Idempotency-Key reutilizado entre os 2 passos pra ligar
 * iniciar->confirmar. Reuso entre tentativas tambem evita debito duplicado.
 */

export interface IniciarPagamentoArgs {
  chave: string;
  cnpj?: string;
  dataAgendamento?: string; // YYYY-MM-DD; vazio = imediato
  idempotencyKey: string;
}

export interface ProprietarioBeneficiario {
  nome?: string;
  cpfCnpj?: string;
  ispb?: string;
  agencia?: string;
  conta?: string;
  tipo?: string;
}

export interface PagamentoIniciado {
  endToEndId: string;
  chave: string;
  tipo?: string;
  proprietario?: ProprietarioBeneficiario;
}

export interface ConfirmarPagamentoArgs {
  endToEndId: string;
  valor: string; // formato BR "1,99"
  descricao?: string;
  meioIniciacao: string; // ex: "MAN" (manual) ou "QRD" — Sicoob aceita "MAN"
  cnpj?: string;
  dataAgendamento?: string;
  repeticao?: boolean;
  idempotencyKey: string;
}

export interface PagamentoSnapshot {
  endToEndId: string;
  estado: string;
  valor: number;
  horario?: string;
  dataAgendamento?: string;
  detalheRejeicao?: string;
  destino?: ProprietarioBeneficiario;
  origem?: ProprietarioBeneficiario;
  descricao?: string;
}

export type PixApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; erro: string; raw?: unknown };

// CNPJ pagador default — Ethos Servicos. Usado quando agendamento nao
// tem CNPJ (empresa sem cadastro completo).
const PIX_CNPJ_DEFAULT = '61485183000177';

function envOk(): { url: string; key: string; clientId: string } | null {
  const url = process.env.PIX_API_URL;
  const key = process.env.PIX_API_KEY;
  // client_id eh obrigatorio em /pix-pagamentos/v2/* (camada do Sicoob).
  // Pode vir do CNPJ pagador via SSM ou fixo no env.
  const clientId = process.env.PIX_API_CLIENT_ID;
  if (!url || !key) {
    console.warn('[PIX] PIX_API_URL ou PIX_API_KEY nao configurados');
    return null;
  }
  return {
    url: url.replace(/\/$/, ''),
    key,
    clientId: clientId ?? '',
  };
}

async function postJson<T>(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<PixApiResult<T>> {
  const env = envOk();
  if (!env) return { ok: false, erro: 'pix_api_nao_configurada' };
  try {
    const resp = await fetch(`${env.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: env.key,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
        ...(env.clientId ? { client_id: env.clientId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // resposta nao-JSON
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        erro: `http_${resp.status}: ${text.slice(0, 400)}`,
        raw: parsed,
      };
    }
    return { ok: true, data: parsed as T };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

export interface CadastrarBeneficiarioArgs {
  chavePix: string;
  tipoChave: string; // cpf|cnpj|email|telefone|aleatoria
  nomeBeneficiario: string;
  documentoBeneficiario?: string; // CPF/CNPJ do dono da chave
  cnpj?: string;
  valorMaximoCentavos?: number; // 0 = sem limite
}

/**
 * Cadastra beneficiário na allowlist da API Sicoob.
 * 201 = criado. 409 = já existe (idempotente — caller trata como sucesso).
 * Outros = falha real.
 */
/**
 * Normaliza chave PIX pro formato exato que o DICT/Sicoob espera:
 *   - telefone: E.164 com +55 (ex: +5562996183309)
 *   - cpf/cnpj: só dígitos
 *   - email: lowercase + trim
 *   - aleatoria/EVP: UUID lowercase
 */
function normalizarChavePix(chave: string, tipo: string): string {
  const t = tipo.trim().toUpperCase();
  const c = chave.trim();
  if (t === 'TELEFONE') {
    let d = c.replace(/\D/g, '');
    if (d.startsWith('55')) d = d.slice(2);
    if (d.length === 10) d = d.slice(0, 2) + '9' + d.slice(2);
    if (d.length !== 11) return c; // formato inesperado, devolve raw
    return `+55${d}`;
  }
  if (t === 'CPF' || t === 'CNPJ') return c.replace(/\D/g, '');
  if (t === 'EMAIL') return c.toLowerCase();
  if (t === 'EVP' || t === 'ALEATORIA') return c.toLowerCase();
  return c;
}

/**
 * Mapeia tipos do nosso domínio (lowercase) pro enum exigido pelo Sicoob
 * (uppercase + EVP em vez de aleatoria).
 */
function tipoChaveSicoob(tipo: string): string {
  const t = tipo.trim().toUpperCase();
  if (t === 'ALEATORIA') return 'EVP';
  return t;
}

export async function cadastrarBeneficiarioPix(
  args: CadastrarBeneficiarioArgs,
): Promise<PixApiResult<{ id?: number } & Record<string, unknown>>> {
  const env = envOk();
  if (!env) return { ok: false, erro: 'pix_api_nao_configurada' };
  try {
    const tipoNorm = tipoChaveSicoob(args.tipoChave);
    const chaveNorm = normalizarChavePix(args.chavePix, tipoNorm);
    const resp = await fetch(`${env.url}/pix-pagamentos/v2/beneficiarios`, {
      method: 'POST',
      headers: {
        Authorization: env.key,
        'Content-Type': 'application/json',
        ...(env.clientId ? { client_id: env.clientId } : {}),
      },
      body: JSON.stringify({
        ...args,
        tipoChave: tipoNorm,
        chavePix: chaveNorm,
      }),
    });
    const text = await resp.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* noop */ }
    // 409 = já existe → tratado como sucesso (idempotente).
    if (resp.status === 409) {
      return { ok: true, data: { ...(parsed as object ?? {}), jaExistia: true } };
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        erro: `http_${resp.status}: ${text.slice(0, 400)}`,
        raw: parsed,
      };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

/**
 * Lista beneficiários cadastrados na allowlist da API filtrando por chave PIX.
 * Retorna array bruto; caller decide o que fazer (pegar id, contar, etc).
 */
export async function listarBeneficiariosPorChave(
  chavePix: string,
  tipoChave: string,
): Promise<PixApiResult<Array<Record<string, unknown>>>> {
  const env = envOk();
  if (!env) return { ok: false, erro: 'pix_api_nao_configurada' };
  try {
    const tipoNorm = tipoChaveSicoob(tipoChave);
    const chaveNorm = normalizarChavePix(chavePix, tipoNorm);
    const url = new URL(`${env.url}/pix-pagamentos/v2/beneficiarios`);
    url.searchParams.set('chavePix', chaveNorm);
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: env.key,
        ...(env.clientId ? { client_id: env.clientId } : {}),
      },
    });
    const text = await resp.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* noop */ }
    if (!resp.ok) {
      return { ok: false, status: resp.status, erro: `http_${resp.status}: ${text.slice(0, 400)}`, raw: parsed };
    }
    const arr = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)
          ? ((parsed as { items: Array<Record<string, unknown>> }).items)
          : []);
    return { ok: true, data: arr };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

/**
 * Remove beneficiário pelo identificador retornado pela API
 * (id numérico, uuid, ou a própria chave normalizada — depende do que a
 * API aceita). Tenta DELETE /pix-pagamentos/v2/beneficiarios/{id}.
 */
export async function excluirBeneficiarioPix(
  identificador: string | number,
): Promise<PixApiResult<Record<string, unknown> | null>> {
  const env = envOk();
  if (!env) return { ok: false, erro: 'pix_api_nao_configurada' };
  try {
    const resp = await fetch(
      `${env.url}/pix-pagamentos/v2/beneficiarios/${encodeURIComponent(String(identificador))}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: env.key,
          ...(env.clientId ? { client_id: env.clientId } : {}),
        },
      },
    );
    const text = await resp.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* noop */ }
    if (!resp.ok) {
      return { ok: false, status: resp.status, erro: `http_${resp.status}: ${text.slice(0, 400)}`, raw: parsed };
    }
    return { ok: true, data: (parsed as Record<string, unknown> | null) };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

export async function iniciarPagamentoPix(
  args: IniciarPagamentoArgs & { tipoChave?: string },
): Promise<PixApiResult<PagamentoIniciado>> {
  const tipoNorm = args.tipoChave ? tipoChaveSicoob(args.tipoChave) : '';
  const chave = tipoNorm
    ? normalizarChavePix(args.chave, tipoNorm)
    : args.chave;
  const body: Record<string, unknown> = { chave };
  if (args.cnpj) body.cnpj = args.cnpj;
  if (args.dataAgendamento) body.dataAgendamento = args.dataAgendamento;
  return postJson<PagamentoIniciado>(
    '/pix-pagamentos/v2/iniciar',
    body,
    args.idempotencyKey,
  );
}

// Reexportados pro caller normalizar antes de gravar/exibir.
export { normalizarChavePix, tipoChaveSicoob, PIX_CNPJ_DEFAULT };

export async function confirmarPagamentoPix(
  args: ConfirmarPagamentoArgs,
): Promise<PixApiResult<PagamentoSnapshot>> {
  const body: Record<string, unknown> = {
    endToEndId: args.endToEndId,
    valor: args.valor,
    meioIniciacao: args.meioIniciacao,
  };
  if (args.descricao) body.descricao = args.descricao;
  if (args.cnpj) body.cnpj = args.cnpj;
  if (args.dataAgendamento) body.dataAgendamento = args.dataAgendamento;
  if (typeof args.repeticao === 'boolean') body.repeticao = args.repeticao;
  return postJson<PagamentoSnapshot>(
    '/pix-pagamentos/v2/confirmar',
    body,
    args.idempotencyKey,
  );
}

export async function consultarPagamentoPix(
  endToEndId: string,
): Promise<PixApiResult<PagamentoSnapshot>> {
  const env = envOk();
  if (!env) return { ok: false, erro: 'pix_api_nao_configurada' };
  try {
    const resp = await fetch(
      `${env.url}/pix-pagamentos/v2/${encodeURIComponent(endToEndId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: env.key,
          ...(env.clientId ? { client_id: env.clientId } : {}),
        },
      },
    );
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* noop */ }
    if (!resp.ok) {
      return { ok: false, status: resp.status, erro: `http_${resp.status}: ${text.slice(0, 400)}`, raw: parsed };
    }
    return { ok: true, data: parsed as PagamentoSnapshot };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

/**
 * Converte valor (number em reais, ex 12.5) pro formato brasileiro
 * "12,50" exigido pelo Sicoob no body do /confirmar.
 */
export function formatarValorBR(valor: number): string {
  return valor.toFixed(2).replace('.', ',');
}
