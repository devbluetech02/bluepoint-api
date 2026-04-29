// =====================================================
// Extração de campos pessoais do JSONB `dados` da solicitação de admissão
// =====================================================
//
// O formulário de admissão é dinâmico (RH configura campos via builder),
// então não há chaves fixas em `dados`. Este módulo aplica a heurística
// de **substring de label** (case-insensitive) pra achar cada campo-alvo
// do colaborador. Mesma lógica usada hoje pelo frontend pra montar o
// payload de `POST /criar-colaborador`.
//
// Usado exclusivamente no fluxo de readmissão (colaborador inativo → ativo).
// Não replica em outros endpoints — débito técnico conhecido.

import type { FormularioCampoApi } from './formulario-admissao';

const VIACEP_TIMEOUT_MS = 5000;

// Campos com "emergência"/"emergencia" no label nunca entram na heurística
// (evita capturar "Telefone de emergência" como telefone principal).
function labelValido(label: string): boolean {
  const l = (label || '').toLowerCase();
  return !(l.includes('emergência') || l.includes('emergencia'));
}

function labelContem(label: string, needles: string[]): boolean {
  const l = (label || '').toLowerCase();
  return needles.some((n) => l.includes(n));
}

function extrairValorPorLabel(
  campos: FormularioCampoApi[],
  dados: Record<string, unknown>,
  needles: string[],
  exclusoes: string[] = []
): string | null {
  for (const campo of campos) {
    if (!campo.id) continue;
    if (!labelValido(campo.label)) continue;
    if (exclusoes.length && labelContem(campo.label, exclusoes)) continue;
    if (!labelContem(campo.label, needles)) continue;
    const raw = dados[campo.id];
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (s === '') continue;
    return s;
  }
  return null;
}

const soDigitos = (v: string): string => v.replace(/\D/g, '');

/** Parse DD/MM/YYYY ou YYYY-MM-DD → YYYY-MM-DD; retorna null se inválido. */
function parseDataParaIso(raw: string): string | null {
  const v = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(v);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

// Mapa de nomes de estados completos pra UF. Inclui variações com/sem acento.
const ESTADO_PARA_UF: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amapá: 'AP', amazonas: 'AM',
  bahia: 'BA', ceara: 'CE', ceará: 'CE', 'distrito federal': 'DF',
  'espirito santo': 'ES', 'espírito santo': 'ES', goias: 'GO', goiás: 'GO',
  maranhao: 'MA', maranhão: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', para: 'PA', pará: 'PA', paraiba: 'PB', paraíba: 'PB',
  parana: 'PR', paraná: 'PR', pernambuco: 'PE', piaui: 'PI', piauí: 'PI',
  'rio de janeiro': 'RJ', 'rio grande do norte': 'RN', 'rio grande do sul': 'RS',
  rondonia: 'RO', rondônia: 'RO', roraima: 'RR', 'santa catarina': 'SC',
  'sao paulo': 'SP', 'são paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
};

function normalizarUF(raw: string): string | null {
  const v = raw.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const uf = ESTADO_PARA_UF[v.toLowerCase()];
  return uf ?? null;
}

// =====================================================
// ViaCEP fallback
// =====================================================

interface ViaCepResponse {
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean | string;
}

async function consultarViaCep(cep: string): Promise<ViaCepResponse | null> {
  const cepLimpo = soDigitos(cep);
  if (cepLimpo.length !== 8) return null;

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), VIACEP_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as ViaCepResponse;
    if (data?.erro) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

// =====================================================
// Extração principal
// =====================================================

export interface CamposExtraidos {
  email?: string;
  telefone?: string;
  rg?: string;
  rg_orgao_emissor?: string;
  rg_uf?: string;                 // UF 2 letras
  data_nascimento?: string;       // ISO YYYY-MM-DD
  endereco_cep?: string;
  endereco_logradouro?: string;
  endereco_numero?: string;
  endereco_complemento?: string;
  endereco_bairro?: string;
  endereco_cidade?: string;
  endereco_estado?: string;       // UF 2 letras
  vale_transporte?: boolean;
  vale_alimentacao?: boolean;
  auxilio_combustivel?: boolean;
  // Senha definida pelo candidato no formulário (texto cru — caller faz hash)
  senha?: string;
  // Dados pessoais adicionais
  estado_civil?: string;
  formacao?: string;
  cor_raca?: string;
  // Dados bancários
  banco_nome?: string;
  banco_tipo_conta?: string;
  banco_agencia?: string;
  banco_conta?: string;
  pix_tipo?: string;
  pix_chave?: string;
  // Dados complementares
  uniforme_tamanho?: string;
  altura_metros?: number;
  peso_kg?: number;
  contato_emergencia_nome?: string;
  contato_emergencia_telefone?: string;
}

/**
 * Itera sobre `campos` do formulário, pega `dados[campo.id]` e aplica
 * a heurística de label pra preencher os campos-alvo do colaborador.
 * Só inclui no objeto resultado os campos que tiveram valor extraído
 * não-vazio — o UPDATE deve ser dinâmico e ignorar os ausentes.
 *
 * Se o CEP vier mas o endereço expandido estiver vazio, consulta ViaCEP
 * e preenche os faltantes.
 */
export async function extrairCamposPessoaisParaColaborador(
  campos: FormularioCampoApi[],
  dados: Record<string, unknown>
): Promise<CamposExtraidos> {
  const out: CamposExtraidos = {};

  // Strings simples + trim
  const email = extrairValorPorLabel(campos, dados, ['e-mail', 'email']);
  if (email) out.email = email;

  // RG principal — exclui campos vizinhos com "rg" no label (órgão emissor, UF RG)
  const rg = extrairValorPorLabel(
    campos,
    dados,
    ['rg', 'identidade'],
    ['órgão', 'orgao', 'emissor', 'uf rg', 'rg uf']
  );
  if (rg) out.rg = rg;

  const rgOrgao = extrairValorPorLabel(campos, dados, ['órgão emissor', 'orgao emissor', 'emissor']);
  if (rgOrgao) out.rg_orgao_emissor = rgOrgao;

  const rgUfRaw = extrairValorPorLabel(campos, dados, ['uf rg', 'rg uf']);
  if (rgUfRaw) {
    const uf = normalizarUF(rgUfRaw);
    if (uf) out.rg_uf = uf;
  }

  // Telefone: só dígitos
  const telRaw = extrairValorPorLabel(campos, dados, ['telefone', 'celular', 'whatsapp']);
  if (telRaw) {
    const d = soDigitos(telRaw);
    if (d) out.telefone = d;
  }

  // Data de nascimento
  const nascRaw = extrairValorPorLabel(campos, dados, ['data de nascimento', 'nascimento', 'data nasc']);
  if (nascRaw) {
    const iso = parseDataParaIso(nascRaw);
    if (iso) out.data_nascimento = iso;
  }

  // Endereço — subcampos
  const cepRaw = extrairValorPorLabel(campos, dados, ['cep']);
  if (cepRaw) {
    const d = soDigitos(cepRaw);
    if (d.length === 8) out.endereco_cep = d;
  }

  const logradouro = extrairValorPorLabel(
    campos,
    dados,
    ['endereço', 'endereco', 'logradouro', 'rua'],
    ['complemento', 'número', 'numero', 'nº']
  );
  if (logradouro) out.endereco_logradouro = logradouro;

  const numero = extrairValorPorLabel(campos, dados, ['número', 'numero', 'nº']);
  if (numero) out.endereco_numero = numero;

  const complemento = extrairValorPorLabel(campos, dados, ['complemento']);
  if (complemento) out.endereco_complemento = complemento;

  const bairro = extrairValorPorLabel(campos, dados, ['bairro']);
  if (bairro) out.endereco_bairro = bairro;

  const cidade = extrairValorPorLabel(campos, dados, ['cidade', 'município', 'municipio']);
  if (cidade) out.endereco_cidade = cidade;

  // UF do endereço — exclui "Estado Civil" e "UF RG" pra não confundir
  const estadoRaw = extrairValorPorLabel(
    campos,
    dados,
    ['estado', 'uf'],
    ['civil', 'rg']
  );
  if (estadoRaw) {
    const uf = normalizarUF(estadoRaw);
    if (uf) out.endereco_estado = uf;
  }

  // ViaCEP fallback — só preenche o que faltou
  if (out.endereco_cep &&
      (!out.endereco_logradouro || !out.endereco_bairro || !out.endereco_cidade || !out.endereco_estado)) {
    const via = await consultarViaCep(out.endereco_cep);
    if (via) {
      if (!out.endereco_logradouro && via.logradouro) out.endereco_logradouro = via.logradouro;
      if (!out.endereco_bairro     && via.bairro)     out.endereco_bairro     = via.bairro;
      if (!out.endereco_cidade     && via.localidade) out.endereco_cidade     = via.localidade;
      if (!out.endereco_estado     && via.uf)         out.endereco_estado     = via.uf.toUpperCase();
    }
  }

  // Benefícios — vale_transporte, vale_alimentacao, auxilio_combustivel
  const { vt, va, ac } = extrairVales(campos, dados);
  out.vale_transporte = vt;
  out.vale_alimentacao = va;
  out.auxilio_combustivel = ac;

  // Senha definida pelo candidato (campo "Crie uma senha")
  const senhaRaw = extrairValorPorLabel(campos, dados, ['crie uma senha', 'senha']);
  if (senhaRaw) out.senha = senhaRaw;

  // Estado civil
  const estadoCivil = extrairValorPorLabel(campos, dados, ['estado civil']);
  if (estadoCivil) out.estado_civil = estadoCivil;

  // Formação / escolaridade
  const formacao = extrairValorPorLabel(campos, dados, ['formação', 'formacao', 'escolaridade']);
  if (formacao) out.formacao = formacao;

  // Cor / raça / etnia
  const corRaca = extrairValorPorLabel(campos, dados, ['cor', 'raça', 'raca', 'etnia']);
  if (corRaca) out.cor_raca = corRaca;

  // Dados bancários — exclui "tipo de conta" da busca por "conta" pra não conflitar
  const bancoNome = extrairValorPorLabel(campos, dados, ['banco']);
  if (bancoNome) out.banco_nome = bancoNome;

  const tipoConta = extrairValorPorLabel(campos, dados, ['tipo de conta', 'tipo da conta']);
  if (tipoConta) out.banco_tipo_conta = tipoConta;

  const agencia = extrairValorPorLabel(campos, dados, ['agência', 'agencia']);
  if (agencia) out.banco_agencia = agencia;

  const conta = extrairValorPorLabel(
    campos,
    dados,
    ['conta'],
    ['tipo de conta', 'tipo da conta']
  );
  if (conta) out.banco_conta = conta;

  // PIX — "tipo de chave" antes de "chave" pra evitar overlap
  const pixTipo = extrairValorPorLabel(campos, dados, ['tipo de chave pix', 'tipo da chave pix', 'tipo chave pix']);
  if (pixTipo) out.pix_tipo = pixTipo;

  const pixChave = extrairValorPorLabel(
    campos,
    dados,
    ['chave pix', 'pix'],
    ['tipo de chave', 'tipo da chave', 'tipo chave']
  );
  if (pixChave) out.pix_chave = pixChave;

  // Tamanho do uniforme
  const uniforme = extrairValorPorLabel(campos, dados, ['uniforme', 'tamanho da camisa', 'tamanho camisa']);
  if (uniforme) out.uniforme_tamanho = uniforme;

  // Altura — converte vírgula em ponto e aceita "1,75" / "1.75" / "175" (cm)
  const alturaRaw = extrairValorPorLabel(campos, dados, ['altura']);
  if (alturaRaw) {
    const alt = parseAltura(alturaRaw);
    if (alt !== null) out.altura_metros = alt;
  }

  // Peso — converte vírgula em ponto
  const pesoRaw = extrairValorPorLabel(campos, dados, ['peso']);
  if (pesoRaw) {
    const p = parseFloat(pesoRaw.replace(',', '.'));
    if (Number.isFinite(p) && p > 0) out.peso_kg = p;
  }

  // Contato de emergência (label permitido aqui — labelValido() bloqueia em outros campos)
  const ceNome = extrairValorPorLabelInclusivo(
    campos,
    dados,
    ['nome do contato de emergência', 'nome do contato de emergencia', 'contato de emergência', 'contato de emergencia'],
    ['telefone']
  );
  if (ceNome) out.contato_emergencia_nome = ceNome;

  const ceTelRaw = extrairValorPorLabelInclusivo(
    campos,
    dados,
    ['telefone do contato de emergência', 'telefone do contato de emergencia', 'telefone de emergência', 'telefone de emergencia'],
    []
  );
  if (ceTelRaw) {
    const d = soDigitos(ceTelRaw);
    if (d) out.contato_emergencia_telefone = d;
  }

  return out;
}

/**
 * Variante de extrairValorPorLabel que NÃO aplica labelValido (não bloqueia
 * "emergência"). Usada exclusivamente pra campos de contato de emergência.
 */
function extrairValorPorLabelInclusivo(
  campos: FormularioCampoApi[],
  dados: Record<string, unknown>,
  needles: string[],
  exclusoes: string[] = []
): string | null {
  for (const campo of campos) {
    if (!campo.id) continue;
    if (exclusoes.length && labelContem(campo.label, exclusoes)) continue;
    if (!labelContem(campo.label, needles)) continue;
    const raw = dados[campo.id];
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (s === '') continue;
    return s;
  }
  return null;
}

/**
 * Aceita "1,75", "1.75", "175" (cm), "175 cm". Retorna metros (NUMERIC 3,2 → 0..9.99).
 */
function parseAltura(raw: string): number | null {
  const v = raw.replace(',', '.').replace(/[^\d.]/g, '');
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Heurística: se vier em cm (>= 100), divide por 100
  const metros = n >= 10 ? n / 100 : n;
  if (metros < 0.5 || metros >= 10) return null;
  return Math.round(metros * 100) / 100;
}

/**
 * Heurística de benefícios. Label costuma ser "Vale transporte ou Auxílio
 * combustível?" (select) ou "Benefício" — e o valor indica qual foi escolhido.
 *   - vt: true se valor selecionado contém "transporte"
 *   - ac: true se valor selecionado contém "combustível"/"combustivel"
 *   - va: default true; preservado quando o formulário não dá sinal claro de exclusão
 *
 * vt e ac são mutuamente exclusivos no formulário default — se ambos baterem,
 * mantém ambos true (defensivo, mas raríssimo na prática).
 */
function extrairVales(
  campos: FormularioCampoApi[],
  dados: Record<string, unknown>
): { vt: boolean; va: boolean; ac: boolean } {
  const beneficioCampos = campos.filter((c) => {
    if (!c.id || !labelValido(c.label)) return false;
    const l = c.label.toLowerCase();
    return (
      l.includes('vale transporte') ||
      l.includes('auxílio combustível') ||
      l.includes('auxilio combustivel') ||
      l.includes('benefício') ||
      l.includes('beneficio')
    );
  });

  let vt = false;
  let ac = false;
  const va = true; // default per contrato

  for (const c of beneficioCampos) {
    const raw = dados[c.id!];
    if (raw === undefined || raw === null) continue;
    const v = String(raw).toLowerCase();
    if (v.includes('transporte')) vt = true;
    if (v.includes('combustível') || v.includes('combustivel')) ac = true;
  }

  return { vt, va, ac };
}
