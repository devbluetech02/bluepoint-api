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

import { query, queryRecrutamento } from './db';
import {
  enviarMensagemWhatsApp,
  getRecrutamentoEvolutionConfigPorResponsavel,
  type EvolutionConfig,
} from './evolution-api';

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
        // Convite vai pelo People via Evolution WhatsApp (skip_email=true no
        // /send suprime as notificações iniciais do SignProof). O OTP de
        // verificação, disparado quando o candidato abre o link, vai por
        // WhatsApp (auth_method=whatsapp_token).
        notification_channel: 'email',
        auth_method: 'whatsapp_token',
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

/// Recupera o signing_link existente de um doc ja enviado. Usar pra
/// reenviar lembrete pelo WhatsApp sem chamar /send (que so aceita
/// docs em 'draft' — apos primeiro envio o doc fica in_progress e
/// /send retorna 409).
export async function obterSigningLinkExistente(documentId: string): Promise<{ ok: boolean; signingLink?: string; erro?: string }> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey = process.env.SIGNPROOF_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, erro: 'signproof_env_ausente' };

  try {
    const resp = await fetch(`${baseUrl}/api/v1/integration/documents/${documentId}/signing-links`, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, erro: `http_${resp.status}: ${t.slice(0, 200)}` };
    }
    const data = await resp.json() as { signing_links?: { signing_link?: string }[] };
    const link = data.signing_links?.[0]?.signing_link;
    if (!link) return { ok: false, erro: 'sem_signing_link' };
    return { ok: true, signingLink: link };
  } catch (e) {
    return { ok: false, erro: `excecao: ${(e as Error).message}` };
  }
}

export async function enviarDocumentoDiaTeste(documentId: string): Promise<{ ok: boolean; signingLink?: string; erro?: string }> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey = process.env.SIGNPROOF_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, erro: 'signproof_env_ausente' };

  try {
    // skip_email=true suprime TODAS as notificações do SignProof (email + whatsapp).
    // O People envia a mensagem por WhatsApp por conta própria com o signing_link.
    const resp = await fetch(`${baseUrl}/api/v1/integration/documents/${documentId}/send?skip_email=true`, {
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
    // Extrair signing_link do primeiro signer
    let signingLink: string | undefined;
    try {
      const data = await resp.json() as { signing_links?: { signing_link?: string }[] };
      signingLink = data.signing_links?.[0]?.signing_link;
    } catch { /* ignora — link é best-effort */ }
    return { ok: true, signingLink };
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

// ─── Geração de contrato pra um dia específico do processo ────────────
//
// Reaproveitado por:
//   - POST /recrutamento/processos          (criação inicial caminho A)
//   - POST /agendamentos/:id/aprovar
//     (acao='adicionar_dia' — gera contrato NOVO pro novo dia, persiste
//     em dia_teste_agendamento.documento_assinatura_id, dispara WhatsApp).
//
// O contrato é vinculado ao agendamento (não mais ao processo) — assim
// cada dia de teste tem seu próprio documento assinado e o gate de
// pagamento valida por agendamento. Ainda assim, gravamos o ID também
// em processo_seletivo.documento_assinatura_id quando `setarNoProcesso`
// for true (default), pra manter compatibilidade com listagens legadas
// que leem o doc do processo.

const EMPRESA_CONTRATO_DIA_TESTE = 11; // Ethos — sempre

export interface GerarContratoResult {
  ok: boolean;
  documentId: string | null;
  signingLink: string | null;
  signProofErro: string | null;
  whatsappOk: boolean;
  whatsappErro: string | null;
}

export async function gerarEEnviarContratoDiaTeste(args: {
  processoId: string;
  agendamentoId: string;
  data: string;             // YYYY-MM-DD do dia em questão
  valorDiaria: number;
  cargaHoraria: number;
  // 1 = só este dia (default usado em adicionar_dia).
  // Maior quando criação inicial cobrir 2 dias num único contrato.
  diasQtdContrato?: number;
  // Override opcional do template (default: heurística por cargo).
  templateOverride?: string | null;
  // Quando true, também grava o doc id em processo_seletivo
  // (mantém compatibilidade com listagens legadas).
  setarNoProcesso?: boolean;
  // Mensagem WhatsApp custom (acoplada ao link). Default: gerada aqui.
  mensagemWhatsApp?: string;
}): Promise<GerarContratoResult> {
  const diasQtdContrato = args.diasQtdContrato ?? 1;
  const setarNoProcesso = args.setarNoProcesso ?? true;

  // 1. Carrega processo + candidato_id + cargo_id (people).
  const psRes = await query<{
    id: string;
    candidato_recrutamento_id: number | string;
    candidato_cpf_norm: string;
    cargo_id: number;
  }>(
    `SELECT id::text, candidato_recrutamento_id, candidato_cpf_norm, cargo_id
       FROM people.processo_seletivo
      WHERE id = $1::bigint
      LIMIT 1`,
    [args.processoId],
  );
  const ps = psRes.rows[0];
  if (!ps) {
    return {
      ok: false, documentId: null, signingLink: null,
      signProofErro: 'processo_nao_encontrado',
      whatsappOk: false, whatsappErro: null,
    };
  }

  // 2. Busca dados do candidato no banco externo de Recrutamento.
  const candId = typeof ps.candidato_recrutamento_id === 'string'
    ? parseInt(ps.candidato_recrutamento_id, 10)
    : ps.candidato_recrutamento_id;
  const detRes = await queryRecrutamento<{
    nome: string | null;
    cpf: string | null;
    telefone: string | null;
    rg_candidato: string | null;
    cep: string | null;
    logradouro: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
    banco: string | null;
    chave_pix: string | null;
    email: string | null;
    resposavel: string | null;
  }>(
    `SELECT nome, cpf, telefone, rg_candidato, cep, logradouro, bairro,
            cidade, uf, banco, chave_pix, email, resposavel
       FROM public.candidatos
      WHERE id = $1
      LIMIT 1`,
    [candId],
  );
  const det = detRes.rows[0];
  if (!det) {
    return {
      ok: false, documentId: null, signingLink: null,
      signProofErro: 'candidato_nao_encontrado',
      whatsappOk: false, whatsappErro: null,
    };
  }

  const cargo = await fetchDadosCargo(ps.cargo_id);
  if (!cargo) {
    return {
      ok: false, documentId: null, signingLink: null,
      signProofErro: `cargo_nao_encontrado_${ps.cargo_id}`,
      whatsappOk: false, whatsappErro: null,
    };
  }
  const empresa = await fetchDadosEmpresa(EMPRESA_CONTRATO_DIA_TESTE);
  if (!empresa) {
    return {
      ok: false, documentId: null, signingLink: null,
      signProofErro: 'empresa_ethos_nao_encontrada',
      whatsappOk: false, whatsappErro: null,
    };
  }

  const candidatoSnap: CandidatoSnapshot = {
    nome: (det.nome ?? '').trim(),
    cpf: (det.cpf ?? ps.candidato_cpf_norm ?? '').replace(/\D/g, ''),
    rg: det.rg_candidato ?? null,
    endereco: {
      cep: det.cep, logradouro: det.logradouro, bairro: det.bairro,
      cidade: det.cidade, uf: det.uf,
    },
    telefone: (det.telefone ?? '').replace(/\D/g, '') || null,
    banco: det.banco ?? null,
    chavePix: det.chave_pix ?? null,
  };

  if (!candidatoSnap.telefone || candidatoSnap.telefone.length < 10) {
    return {
      ok: false, documentId: null, signingLink: null,
      signProofErro: 'telefone_candidato_invalido',
      whatsappOk: false, whatsappErro: 'sem_telefone',
    };
  }

  const templateId = (args.templateOverride && args.templateOverride.trim() !== '')
    ? args.templateOverride.trim()
    : escolherTemplate(cargo);

  const variaveis = montarVariaveis(templateId, {
    candidato: candidatoSnap,
    cargo,
    empresa,
    dt: {
      diasQtd: diasQtdContrato,
      valorDiaria: args.valorDiaria,
      cargaHoraria: args.cargaHoraria,
      dataPrimeiroDia: args.data,
    },
  });

  const externalRef = `DT-${args.processoId}-A${args.agendamentoId}-${args.data.replace(/-/g, '')}`;
  const primeiroNome = candidatoSnap.nome.split(' ')[0] || 'Candidato';
  const ultimoNome = candidatoSnap.nome.split(' ').slice(-1)[0] || '';
  const title = `Dia de Teste — ${primeiroNome} ${ultimoNome}`.trim();

  const criar = await criarDocumentoDiaTeste({
    templateId,
    variaveis,
    signer: {
      nome: candidatoSnap.nome,
      cpf: candidatoSnap.cpf,
      email: det.email,
      telefone: candidatoSnap.telefone,
    },
    externalRef,
    title,
  });

  if (!criar.ok) {
    return {
      ok: false, documentId: null, signingLink: null,
      signProofErro: `criar:${criar.erro}`,
      whatsappOk: false, whatsappErro: null,
    };
  }
  const documentId = criar.documentId;

  // Persiste no agendamento (sempre) e opcionalmente no processo.
  await query(
    `UPDATE people.dia_teste_agendamento
        SET documento_assinatura_id = $1, atualizado_em = NOW()
      WHERE id = $2::bigint`,
    [documentId, args.agendamentoId],
  );
  if (setarNoProcesso) {
    await query(
      `UPDATE people.processo_seletivo
          SET documento_assinatura_id = $1, atualizado_em = NOW()
        WHERE id = $2::bigint`,
      [documentId, args.processoId],
    );
  }

  // Envia o documento (gera signing link).
  const env = await enviarDocumentoDiaTeste(documentId);
  if (!env.ok) {
    return {
      ok: false, documentId, signingLink: null,
      signProofErro: `enviar:${env.erro ?? '?'}`,
      whatsappOk: false, whatsappErro: null,
    };
  }
  const signingLink = env.signingLink ?? null;

  // WhatsApp pelo recrutador responsável.
  const numeroWhats = candidatoSnap.telefone;
  let whatsappOk = false;
  let whatsappErro: string | null = null;

  if (signingLink && numeroWhats && numeroWhats.length >= 10) {
    const mensagemBase = args.mensagemWhatsApp?.trim() || [
      `Olá, ${primeiroNome}! 👋`,
      '',
      `Foi agendado um novo dia de teste para você. 🎉`,
      '',
      `Para participar, é necessário assinar o contrato deste novo dia. É rápido e 100% digital.`,
      '',
      `Após assinar, basta comparecer no horário combinado.`,
      '',
      `Qualquer dúvida, estamos à disposição!`,
    ].join('\n');
    const mensagem = `${mensagemBase}\n\n📋 *Assinar contrato:*\n${signingLink}`;
    const cfg: EvolutionConfig = getRecrutamentoEvolutionConfigPorResponsavel(det.resposavel);
    const result = await enviarMensagemWhatsApp(numeroWhats, mensagem, cfg);
    whatsappOk = result.ok;
    whatsappErro = result.ok ? null : (result.erro ?? 'falha_desconhecida');
  } else if (!numeroWhats || numeroWhats.length < 10) {
    whatsappErro = 'sem_telefone';
  } else {
    whatsappErro = 'sem_signing_link';
  }

  return {
    ok: true,
    documentId,
    signingLink,
    signProofErro: null,
    whatsappOk,
    whatsappErro,
  };
}
