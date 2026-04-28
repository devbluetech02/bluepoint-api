/**
 * Helpers do caminho A (Dia de Teste) do FLUXO_RECRUTAMENTO.md.
 *
 * Concentra:
 *  - Decisão do template SignProof por cargo (com fallback heurístico).
 *  - Montagem do Record<variavel, string> que cada template exige.
 *  - Wrapper de criar/enviar documento na SignProof. SignProof envia o
 *    contrato pelo WhatsApp por conta própria (notification_channel
 *    forçado no /signproof/documents quando external_ref começa com
 *    DT-/ADM-; aqui usamos DT- pra dia de teste).
 */

import { query } from './db';

// IDs canônicos cadastrados no SignProof (confirmados via
// GET /api/v1/integration/templates):
//   - termo_ciencia_processo_seletivo_v1
//   - contrato_autonomo_v1
const TEMPLATE_TERMO_CIENCIA = 'termo_ciencia_processo_seletivo_v1';
const TEMPLATE_CONTRATO_AUTONOMO = 'contrato_autonomo_v1';

export interface CandidatoSnapshot {
  nome: string;
  cpf: string; // normalizado (11 dígitos)
  rg: string | null;
  endereco: {
    cep: string | null;
    logradouro: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
  };
  telefone: string | null; // normalizado
  banco: string | null;
  chavePix: string | null;
}

export interface DadosCargo {
  id: number;
  nome: string;
  templateDiaTeste: string | null; // override; null = heurística
}

export interface DadosEmpresa {
  id: number;
  nome: string;        // razao_social ou nome_fantasia
  cnpj: string | null;
  endereco: string;    // rua + numero + bairro concatenado
  cep: string | null;
  cidade: string | null;
  uf: string | null;
  cidadeForo: string | null;
}

export interface DadosDiaTeste {
  diasQtd: number;            // 1 ou 2
  valorDiaria: number;        // R$
  cargaHoraria: number;       // h
  dataPrimeiroDia: string;    // YYYY-MM-DD
}

/**
 * Decide qual template usar:
 *  1) cargo.template_dia_teste se presente
 *  2) heurística pelo nome do cargo: "vendedor" → termo_ciencia
 *  3) default: contrato_autonomo
 */
export function escolherTemplate(cargo: DadosCargo): string {
  if (cargo.templateDiaTeste && cargo.templateDiaTeste.trim() !== '') {
    return cargo.templateDiaTeste.trim();
  }
  const nomeNorm = cargo.nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (/\bvendedor[a]?\b/.test(nomeNorm)) return TEMPLATE_TERMO_CIENCIA;
  return TEMPLATE_CONTRATO_AUTONOMO;
}

// ─── Formatadores ─────────────────────────────────────────────────────

function fmtDataBR(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fmtMoedaBR(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

function fmtCnpj(cnpj: string | null): string {
  if (!cnpj) return '';
  const d = cnpj.replace(/\D/g, '');
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

function addDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Versão minimalista de "horas por extenso" — cobre 0–23 com sufixo "horas".
function horasPorExtenso(hh: number): string {
  const nomes = [
    'zero hora', 'uma hora', 'duas horas', 'três horas', 'quatro horas',
    'cinco horas', 'seis horas', 'sete horas', 'oito horas', 'nove horas',
    'dez horas', 'onze horas', 'doze horas', 'treze horas', 'catorze horas',
    'quinze horas', 'dezesseis horas', 'dezessete horas', 'dezoito horas',
    'dezenove horas', 'vinte horas', 'vinte e uma horas', 'vinte e duas horas',
    'vinte e três horas',
  ];
  return nomes[Math.max(0, Math.min(23, hh))] ?? `${hh} horas`;
}

// ─── Montagem das variáveis por template ──────────────────────────────

interface VariavelCtx {
  candidato: CandidatoSnapshot;
  cargo: DadosCargo;
  empresa: DadosEmpresa;
  dt: DadosDiaTeste;
}

export function montarVariaveis(template: string, ctx: VariavelCtx): Record<string, string> {
  const { candidato, cargo, empresa, dt } = ctx;
  const hoje = new Date();
  const dataHoje = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  const data1 = fmtDataBR(dt.dataPrimeiroDia);
  const data2 = dt.diasQtd >= 2 ? fmtDataBR(addDias(dt.dataPrimeiroDia, 1)) : '';

  // Horários default (08:00 às 17:00 com 1h de almoço).
  // Ajustar via jornada do cargo é Sprint 2.2.
  const horarioInicio = '08:00';
  const horarioFim = '17:00';

  const enderecoCandidato = [candidato.endereco.logradouro, candidato.endereco.bairro]
    .filter((s): s is string => !!s && s.trim() !== '')
    .join(', ');

  const base: Record<string, string> = {
    EMPRESA: empresa.nome ?? '',
    CNPJ: fmtCnpj(empresa.cnpj),
    ENDERECO_EMPRESA: empresa.endereco ?? '',
    CEP_EMPRESA: empresa.cep ?? '',
    CIDADE_EMPRESA: empresa.cidade ?? '',
    UF_EMPRESA: empresa.uf ?? '',
    NOME: candidato.nome ?? '',
    RG: candidato.rg ?? '',
    CPF: fmtCpf(candidato.cpf),
    ENDERECO_CONTRATADO: enderecoCandidato,
    CIDADE_CONTRATADO: candidato.endereco.cidade ?? '',
    UF_CONTRATADO: candidato.endereco.uf ?? '',
    CEP_CONTRATADO: candidato.endereco.cep ?? '',
    CARGO: cargo.nome ?? '',
    DATA_HOJE: dataHoje,
  };

  if (template === TEMPLATE_CONTRATO_AUTONOMO) {
    return {
      ...base,
      HORARIO_INICIO: horarioInicio,
      HORARIO_INICIO_EXTENSO: horasPorExtenso(parseInt(horarioInicio.split(':')[0], 10)),
      HORARIO_FIM: horarioFim,
      HORARIO_FIM_EXTENSO: horasPorExtenso(parseInt(horarioFim.split(':')[0], 10)),
      DATA_SERVICO_1: data1,
      DATA_SERVICO_2: data2,
      VALOR_DIARIA: fmtMoedaBR(dt.valorDiaria),
      BANCO: candidato.banco ?? '',
      CHAVE_PIX: candidato.chavePix ?? '',
      FORO_COMARCA: empresa.cidadeForo ?? empresa.cidade ?? '',
    };
  }
  if (template === TEMPLATE_TERMO_CIENCIA) {
    const total = dt.valorDiaria * dt.diasQtd;
    return {
      ...base,
      DATA_TREINAMENTO_1: data1,
      DATA_TREINAMENTO_2: data2,
      VALOR_AJUDA_CUSTO: fmtMoedaBR(dt.valorDiaria),
      VALOR_ALIMENTACAO: fmtMoedaBR(0),
      VALOR_TOTAL: fmtMoedaBR(total),
    };
  }
  // Template desconhecido — ainda assim devolve o base, melhor que vazio.
  return base;
}

// ─── Lookup de empresa pra montar variáveis ───────────────────────────

export async function fetchDadosEmpresa(empresaId: number): Promise<DadosEmpresa | null> {
  const r = await query<{
    id: number;
    razao_social: string | null;
    nome_fantasia: string | null;
    cnpj: string | null;
    rua: string | null;
    numero: string | null;
    bairro: string | null;
    cep: string | null;
    cidade: string | null;
    estado: string | null;
    cidade_foro: string | null;
  }>(
    `SELECT id, razao_social, nome_fantasia, cnpj, rua, numero, bairro, cep,
            cidade, estado, cidade_foro
       FROM people.empresas
      WHERE id = $1`,
    [empresaId]
  );
  if (r.rows.length === 0) return null;
  const e = r.rows[0];
  const enderecoParts = [e.rua, e.numero, e.bairro]
    .filter((s): s is string => !!s && s.trim() !== '');
  return {
    id: e.id,
    nome: e.razao_social || e.nome_fantasia || '',
    cnpj: e.cnpj,
    endereco: enderecoParts.join(', '),
    cep: e.cep,
    cidade: e.cidade,
    uf: e.estado,
    cidadeForo: e.cidade_foro,
  };
}

export async function fetchDadosCargo(cargoId: number): Promise<DadosCargo | null> {
  const r = await query<{ id: number; nome: string; template_dia_teste: string | null }>(
    `SELECT id, nome, template_dia_teste FROM people.cargos WHERE id = $1`,
    [cargoId]
  );
  if (r.rows.length === 0) return null;
  return {
    id: r.rows[0].id,
    nome: r.rows[0].nome,
    templateDiaTeste: r.rows[0].template_dia_teste,
  };
}

// ─── SignProof: criar e enviar documento ──────────────────────────────

export interface SignerInfo {
  nome: string;
  cpf: string;       // só dígitos
  email?: string | null;
  telefone: string;  // só dígitos (com DDD)
}

export type CriarDocumentoResult =
  | { ok: true; documentId: string }
  | { ok: false; erro: string };

export async function criarDocumentoDiaTeste(args: {
  templateId: string;
  variaveis: Record<string, string>;
  signer: SignerInfo;
  externalRef: string; // ex: DT-{processoId}-{yyyymmdd}
  title: string;       // "Dia de Teste — Maria da Silva"
}): Promise<CriarDocumentoResult> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey = process.env.SIGNPROOF_API_KEY;
  if (!baseUrl || !apiKey) {
    return { ok: false, erro: 'signproof_env_ausente' };
  }

  const phoneE164 = normalizePhoneBR(args.signer.telefone);
  if (!phoneE164) return { ok: false, erro: 'telefone_signer_invalido' };

  const body = {
    template_id: args.templateId,
    title: args.title,
    external_ref: args.externalRef,
    source_system: 'people-recrutamento',
    variables: args.variaveis,
    signers: [
      {
        name: args.signer.nome,
        document: args.signer.cpf,
        email: args.signer.email || undefined,
        phone: phoneE164,
        notification_channel: 'email',
        auth_method: 'email_token',
      },
    ],
  };

  try {
    const resp = await fetch(`${baseUrl}/api/v1/integration/documents`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error('[recrutamento/dia-teste] criar documento SignProof falhou:', resp.status, text.slice(0, 500));
      return { ok: false, erro: `http_${resp.status}: ${text.slice(0, 200)}` };
    }
    let data: { id?: string; document_id?: string; data?: { id?: string } } = {};
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, erro: 'json_parse_falhou' };
    }
    const id = data.id ?? data.document_id ?? data.data?.id;
    if (!id) return { ok: false, erro: 'sem_id_no_response' };
    return { ok: true, documentId: id };
  } catch (e) {
    console.error('[recrutamento/dia-teste] excecao ao criar documento:', e);
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

export async function enviarDocumentoDiaTeste(documentId: string): Promise<{ ok: boolean; erro?: string }> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey = process.env.SIGNPROOF_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, erro: 'signproof_env_ausente' };

  try {
    const resp = await fetch(`${baseUrl}/api/v1/integration/documents/${documentId}/send`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, erro: `http_${resp.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

// Cancela o documento na SignProof. Conforme §5 do FLUXO_RECRUTAMENTO,
// disparado mesmo se o documento já estiver assinado pelo candidato.
export async function cancelarDocumentoSignProof(documentId: string): Promise<{ ok: boolean; erro?: string }> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey = process.env.SIGNPROOF_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, erro: 'signproof_env_ausente' };

  try {
    const resp = await fetch(`${baseUrl}/api/v1/integration/documents/${documentId}/cancel`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, erro: `http_${resp.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

function normalizePhoneBR(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55')) d = d.slice(2);
  if (d.length === 10) d = d.slice(0, 2) + '9' + d.slice(2);
  if (d.length !== 11) return null;
  return `55${d}`;
}
