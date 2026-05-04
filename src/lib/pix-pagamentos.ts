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
  cnpjPagador?: string;
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
  cnpjPagador?: string;
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

function envOk(): { url: string; key: string } | null {
  const url = process.env.PIX_API_URL;
  const key = process.env.PIX_API_KEY;
  if (!url || !key) {
    console.warn('[PIX] PIX_API_URL ou PIX_API_KEY nao configurados');
    return null;
  }
  return { url: url.replace(/\/$/, ''), key };
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
  cnpjPagador?: string;
  valorMaximoCentavos?: number; // 0 = sem limite
}

/**
 * Cadastra beneficiário na allowlist da API Sicoob.
 * 201 = criado. 409 = já existe (idempotente — caller trata como sucesso).
 * Outros = falha real.
 */
export async function cadastrarBeneficiarioPix(
  args: CadastrarBeneficiarioArgs,
): Promise<PixApiResult<{ id?: number } & Record<string, unknown>>> {
  const env = envOk();
  if (!env) return { ok: false, erro: 'pix_api_nao_configurada' };
  try {
    const resp = await fetch(`${env.url}/pix-pagamentos/v2/beneficiarios`, {
      method: 'POST',
      headers: {
        Authorization: env.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
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

export async function iniciarPagamentoPix(
  args: IniciarPagamentoArgs,
): Promise<PixApiResult<PagamentoIniciado>> {
  const body: Record<string, unknown> = { chave: args.chave };
  if (args.cnpjPagador) body.cnpjPagador = args.cnpjPagador;
  if (args.dataAgendamento) body.dataAgendamento = args.dataAgendamento;
  return postJson<PagamentoIniciado>(
    '/pix-pagamentos/v2/iniciar',
    body,
    args.idempotencyKey,
  );
}

export async function confirmarPagamentoPix(
  args: ConfirmarPagamentoArgs,
): Promise<PixApiResult<PagamentoSnapshot>> {
  const body: Record<string, unknown> = {
    endToEndId: args.endToEndId,
    valor: args.valor,
    meioIniciacao: args.meioIniciacao,
  };
  if (args.descricao) body.descricao = args.descricao;
  if (args.cnpjPagador) body.cnpjPagador = args.cnpjPagador;
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
        headers: { Authorization: env.key },
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
