// =====================================================
// Integração com API Externa - Portal do Colaborador
// Módulo para registro automático de ocorrências
// =====================================================

import { query } from '@/lib/db';

const PORTAL_BASE_URL =
  process.env.PORTAL_COLABORADOR_URL || 'http://portal-do-colaborador.bluetechfilms.com.br';
const PORTAL_API_KEY =
  process.env.PORTAL_COLABORADOR_API_KEY || '';

const SERVICE_TIMEOUT = 10000; // 10 segundos

// =====================================================
// INTERFACES
// =====================================================

interface ColaboradorPortal {
  id: number;
  nome_completo: string;
  matricula: string | null;
  cargo: string;
  departamento: string;
  filial: string;
  status: string;
  email: string;
}

interface ColaboradoresResponse {
  success: boolean;
  data?: ColaboradorPortal[];
  pagination?: {
    total: number;
  };
  message?: string;
}

interface TipoOcorrenciaClassificado {
  id: number;
  tipo: string;
  gravidade: number;
  classificacao: string;
  mensagem_padrao: string | null;
}

interface TiposResponse {
  success: boolean;
  data?: {
    classificados: TipoOcorrenciaClassificado[];
    simplificados: unknown[];
  };
  message?: string;
}

interface CriarOcorrenciaPayload {
  colaborador_id?: number;
  matricula?: string;
  tipo_ocorrencia_id?: number;
  tipo_simplificado_id?: number;
  data_ocorrencia: string;
  descricao: string;
  origem?: string;
  usuario_criador_nome?: string;
}

interface OcorrenciaResponseData {
  id: number;
  colaborador_id: number;
  colaborador_nome: string;
  data_ocorrencia: string;
  tipo_ocorrencia: string;
  tipo_ocorrencia_id: number | null;
  tipo_simplificado_id: number | null;
  gravidade: number | null;
  classificacao: string;
  descricao: string;
  status: string;
  criado_em: string;
}

interface OcorrenciaResponse {
  success: boolean;
  message: string;
  data?: OcorrenciaResponseData;
  error?: string;
}

// =====================================================
// TIPOS DE ATRASO POR FAIXA DE MINUTOS
// =====================================================
// Mapeamento dos tipos reais do Portal do Colaborador.
// Como o ponto registra automaticamente (sem aviso prévio do
// colaborador), usamos a categoria "SEM INFORME".
//
// Faixas:
//   10-20 min  → "ATRASO SEM INFORME 10-20 MIN"
//   20-60 min  → "ATRASO SEM INFORME 20-60 MIN"
//   >60 min    → "ATRASO SEM INFORME MAIS DE 60 MIN"
// =====================================================

interface TipoAtrasoPorFaixa {
  minMinutos: number;
  maxMinutos: number; // Infinity para "mais de X"
  palavrasChave: string[]; // Palavras que o nome do tipo deve conter
  tipoId: number | null; // Preenchido pelo cache
}

const FAIXAS_ATRASO: TipoAtrasoPorFaixa[] = [
  { minMinutos: 0, maxMinutos: 20, palavrasChave: ['atraso', 'sem informe', '10-20'], tipoId: null },
  { minMinutos: 20, maxMinutos: 60, palavrasChave: ['atraso', 'sem informe', '20-60'], tipoId: null },
  { minMinutos: 60, maxMinutos: Infinity, palavrasChave: ['atraso', 'sem informe', 'mais de 60'], tipoId: null },
];

// =====================================================
// CACHE - Tipos de Ocorrência de Atraso
// =====================================================

let tiposAtrasoCacheExpira: number = 0;
const TIPO_CACHE_TTL = 1000 * 60 * 60; // 1 hora

// =====================================================
// CACHE - Mapeamento Colaborador BluePoint → Portal
// =====================================================

const colaboradorCache = new Map<
  string,
  { portalId: number; matricula: string | null; expiraEm: number }
>();
const COLABORADOR_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 horas

// =====================================================
// HELPER - Fetch com timeout
// =====================================================

async function fetchComTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// =====================================================
// BUSCAR COLABORADOR NO PORTAL
// =====================================================

/**
 * Busca um colaborador no Portal do Colaborador pelo nome.
 * O resultado é cacheado por 24h para evitar lookups repetidos.
 */
async function buscarColaboradorNoPortal(
  nomeColaborador: string
): Promise<{ portalId: number; matricula: string | null } | null> {
  const agora = Date.now();
  const cacheKey = nomeColaborador.toLowerCase().trim();

  // Verificar cache
  const cached = colaboradorCache.get(cacheKey);
  if (cached && agora < cached.expiraEm) {
    return { portalId: cached.portalId, matricula: cached.matricula };
  }

  try {
    const searchParam = encodeURIComponent(nomeColaborador);
    const response = await fetchComTimeout(
      `${PORTAL_BASE_URL}/api/external/colaboradores?search=${searchParam}&status=ativo&limit=5`,
      {
        method: 'GET',
        headers: { 'X-API-Key': PORTAL_API_KEY },
      }
    );

    if (!response.ok) {
      console.warn(`[Ocorrência] Portal retornou HTTP ${response.status} ao buscar colaborador.`);
      return null;
    }

    const data: ColaboradoresResponse = await response.json();

    if (!data.success || !data.data || data.data.length === 0) {
      console.warn(
        `[Ocorrência] Colaborador "${nomeColaborador}" não encontrado no Portal do Colaborador.`
      );
      return null;
    }

    // Buscar correspondência exata pelo nome (case-insensitive)
    const nomeNormalizado = nomeColaborador.toLowerCase().trim();
    let colaborador = data.data.find(
      (c) => c.nome_completo.toLowerCase().trim() === nomeNormalizado
    );

    // Se não achar exato, usar o primeiro resultado (busca parcial)
    if (!colaborador) {
      colaborador = data.data[0];
      console.log(
        `[Ocorrência] Match exato não encontrado para "${nomeColaborador}". ` +
          `Usando melhor resultado: "${colaborador.nome_completo}"`
      );
    }

    // Cachear o resultado
    const resultado = { portalId: colaborador.id, matricula: colaborador.matricula };
    colaboradorCache.set(cacheKey, {
      ...resultado,
      expiraEm: agora + COLABORADOR_CACHE_TTL,
    });

    console.log(
      `[Ocorrência] Colaborador encontrado no Portal: "${colaborador.nome_completo}" ` +
        `(ID: ${colaborador.id}, matrícula: ${colaborador.matricula || 'N/A'})`
    );

    return resultado;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('[Ocorrência] Timeout ao buscar colaborador no Portal.');
    } else {
      console.error('[Ocorrência] Erro ao buscar colaborador no Portal:', error);
    }
    return null;
  }
}

// =====================================================
// BUSCAR E CACHEAR TIPOS DE ATRASO POR FAIXA
// =====================================================

/**
 * Busca os tipos de ocorrência no Portal e mapeia os IDs
 * corretos para cada faixa de atraso (SEM INFORME).
 *
 * Lógica reversa ao cargo→tipo: aqui usamos palavras-chave
 * no nome do tipo para encontrar o ID correto por faixa de minutos.
 */
async function carregarTiposAtraso(): Promise<void> {
  const agora = Date.now();

  if (agora < tiposAtrasoCacheExpira && FAIXAS_ATRASO.every((f) => f.tipoId !== null)) {
    return; // Cache ainda válido
  }

  try {
    const response = await fetchComTimeout(
      `${PORTAL_BASE_URL}/api/external/ocorrencias/tipos?categoria=classificados`,
      {
        method: 'GET',
        headers: { 'X-API-Key': PORTAL_API_KEY },
      }
    );

    if (!response.ok) {
      console.warn(`[Ocorrência] Portal retornou HTTP ${response.status} ao buscar tipos.`);
      return;
    }

    const data: TiposResponse = await response.json();

    if (!data.success || !data.data?.classificados) {
      console.warn('[Ocorrência] Resposta inválida ao buscar tipos de ocorrência.');
      return;
    }

    const tipos = data.data.classificados;

    // Para cada faixa, encontrar o tipo correspondente usando palavras-chave
    for (const faixa of FAIXAS_ATRASO) {
      const tipoEncontrado = tipos.find((t) => {
        const nomeNormalizado = t.tipo.toLowerCase();
        return faixa.palavrasChave.every((palavra) => nomeNormalizado.includes(palavra));
      });

      if (tipoEncontrado) {
        faixa.tipoId = tipoEncontrado.id;
        console.log(
          `[Ocorrência] Faixa ${faixa.minMinutos}-${faixa.maxMinutos === Infinity ? '∞' : faixa.maxMinutos} min ` +
            `→ "${tipoEncontrado.tipo}" (ID: ${tipoEncontrado.id}, gravidade: ${tipoEncontrado.gravidade})`
        );
      } else {
        console.warn(
          `[Ocorrência] Tipo de atraso não encontrado para faixa ${faixa.minMinutos}-${faixa.maxMinutos === Infinity ? '∞' : faixa.maxMinutos} min. ` +
            `Palavras-chave: ${faixa.palavrasChave.join(', ')}`
        );
      }
    }

    tiposAtrasoCacheExpira = agora + TIPO_CACHE_TTL;
  } catch (error) {
    console.warn('[Ocorrência] Erro ao buscar tipos de ocorrência:', error);
  }
}

/**
 * Retorna o tipo_ocorrencia_id correto baseado nos minutos de atraso.
 *
 * Mapeamento (mesma lógica do cargo→tipo, porém reversa: minutos→tipo_ocorrencia):
 *   10-20 min  → "ATRASO SEM INFORME 10-20 MIN"  (gravidade 2)
 *   20-60 min  → "ATRASO SEM INFORME 20-60 MIN"  (gravidade 3)
 *   >60 min    → "ATRASO SEM INFORME MAIS DE 60 MIN" (gravidade 5)
 */
async function obterTipoAtrasoIdPorMinutos(minutos: number): Promise<number | null> {
  await carregarTiposAtraso();

  // Encontrar a faixa correta
  for (const faixa of FAIXAS_ATRASO) {
    if (minutos >= faixa.minMinutos && minutos < faixa.maxMinutos) {
      if (faixa.tipoId) {
        return faixa.tipoId;
      }
    }
  }

  // Fallback: usar a última faixa (>60 min) se nenhuma corresponder
  const ultimaFaixa = FAIXAS_ATRASO[FAIXAS_ATRASO.length - 1];
  if (ultimaFaixa.tipoId) {
    return ultimaFaixa.tipoId;
  }

  console.warn(`[Ocorrência] Nenhum tipo encontrado para ${minutos} min de atraso.`);
  return null;
}

// =====================================================
// FUNÇÃO PRINCIPAL - Registrar Ocorrência de Atraso
// =====================================================

/**
 * Registra uma ocorrência de atraso no Portal do Colaborador.
 *
 * Fluxo:
 *  1. Busca o colaborador no Portal via GET /api/external/colaboradores?search=<nome>
 *     para obter o ID correto no sistema do Portal.
 *  2. Busca o tipo de ocorrência correto baseado nos minutos de atraso
 *     (seleciona a faixa "SEM INFORME" adequada).
 *  3. Cria a ocorrência via POST /api/external/ocorrencias já classificada
 *     automaticamente — o DP não precisa analisar manualmente.
 *
 * Ambas as buscas são cacheadas em memória (colaborador: 24h, tipos: 1h).
 * Em caso de falha, o erro é logado mas o fluxo de registro de ponto continua.
 */
export async function registrarOcorrenciaAtraso(params: {
  colaboradorNome: string;
  dataOcorrencia: string;
  minutosAtraso: number;
  marcacaoId?: number;
}): Promise<OcorrenciaResponse | null> {
  if (!PORTAL_API_KEY) {
    console.warn('[Ocorrência] PORTAL_COLABORADOR_API_KEY não configurada. Ocorrência não registrada.');
    return null;
  }

  try {
    // 1. Buscar o colaborador no Portal pelo nome
    const colaboradorPortal = await buscarColaboradorNoPortal(params.colaboradorNome);

    if (!colaboradorPortal) {
      console.warn(
        `[Ocorrência] Não foi possível identificar "${params.colaboradorNome}" no Portal. Ocorrência não registrada.`
      );
      return null;
    }

    // 2. Obter o tipo correto baseado nos minutos de atraso
    const tipoOcorrenciaId = await obterTipoAtrasoIdPorMinutos(params.minutosAtraso);

    if (!tipoOcorrenciaId) {
      console.warn(
        `[Ocorrência] Tipo de ocorrência não encontrado para ${params.minutosAtraso} min. Ocorrência não registrada.`
      );
      return null;
    }

    // 3. Criar a ocorrência usando o ID do colaborador no Portal
    const payload: CriarOcorrenciaPayload = {
      colaborador_id: colaboradorPortal.portalId,
      tipo_ocorrencia_id: tipoOcorrenciaId,
      data_ocorrencia: params.dataOcorrencia,
      descricao: `Atraso de ${params.minutosAtraso} minutos registrado automaticamente pelo sistema de ponto BluePoint.`,
      origem: 'BluePoint - Sistema de Ponto',
      usuario_criador_nome: 'BluePoint API (Automático)',
    };

    console.log(
      `[Ocorrência] Registrando atraso: ${params.colaboradorNome} ` +
        `(Portal ID: ${colaboradorPortal.portalId}) ` +
        `- ${params.minutosAtraso} min → tipo_ocorrencia_id: ${tipoOcorrenciaId}`
    );

    const response = await fetchComTimeout(
      `${PORTAL_BASE_URL}/api/external/ocorrencias`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PORTAL_API_KEY,
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.warn(
        `[Ocorrência] Portal retornou HTTP ${response.status} ao criar ocorrência: ${text.substring(0, 200)}`
      );
      return null;
    }

    const data: OcorrenciaResponse = await response.json();

    if (data.success && data.data?.id) {
      console.log(
        `[Ocorrência] ✓ Atraso registrado com sucesso! Ocorrência #${data.data.id} ` +
          `- ${params.colaboradorNome} - ${params.minutosAtraso} min ` +
          `- Tipo: ${data.data.tipo_ocorrencia} (gravidade: ${data.data.gravidade})`
      );

      // Salvar o ID da ocorrência na marcação para uso posterior (justificativa)
      if (params.marcacaoId) {
        try {
          await query(
            `UPDATE people.marcacoes SET ocorrencia_portal_id = $1 WHERE id = $2`,
            [data.data.id, params.marcacaoId]
          );
          console.log(
            `[Ocorrência] Portal ID #${data.data.id} vinculado à marcação #${params.marcacaoId}`
          );
        } catch (dbErr) {
          console.error('[Ocorrência] Erro ao vincular portal ID à marcação:', dbErr);
        }
      }
    } else {
      console.warn(
        `[Ocorrência] Falha ao registrar atraso para ${params.colaboradorNome}: ${data.message || data.error}`
      );
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(
        `[Ocorrência] Timeout ao comunicar com Portal do Colaborador (${SERVICE_TIMEOUT}ms)`
      );
    } else {
      console.error('[Ocorrência] Erro na comunicação com Portal do Colaborador:', error);
    }
    return null;
  }
}

// =====================================================
// REGISTRAR READMISSÃO DE EX-COLABORADOR
// =====================================================

/**
 * Registra uma ocorrência "Readmissão" no Portal do Colaborador quando um
 * ex-colaborador (status='inativo' no BluePoint) é readmitido via fluxo de admissão.
 *
 * Busca o colaborador no Portal pelo nome e o tipo de ocorrência que contenha
 * "readmiss" (case-insensitive). Se qualquer um dos dois falhar, a ocorrência
 * não é registrada — fail-silent pra não travar a transição admitido.
 */
export async function registrarOcorrenciaReadmissao(params: {
  nomeColaborador: string;
  cpf: string;
  dataReadmissao: string;              // YYYY-MM-DD
  dataDesligamentoAnterior: string | null;
}): Promise<OcorrenciaResponse | null> {
  if (!PORTAL_API_KEY) {
    console.warn('[Ocorrência] PORTAL_COLABORADOR_API_KEY não configurada. Readmissão não registrada.');
    return null;
  }

  try {
    const colaboradorPortal = await buscarColaboradorNoPortal(params.nomeColaborador);
    if (!colaboradorPortal) {
      console.warn(
        `[Ocorrência] Colaborador "${params.nomeColaborador}" não encontrado no Portal — readmissão não registrada.`
      );
      return null;
    }

    const tipoResponse = await fetchComTimeout(
      `${PORTAL_BASE_URL}/api/external/ocorrencias/tipos?categoria=classificados`,
      { method: 'GET', headers: { 'X-API-Key': PORTAL_API_KEY } }
    );
    let tipoReadmissaoId: number | null = null;
    if (tipoResponse.ok) {
      const tiposJson: TiposResponse = await tipoResponse.json();
      const tipo = tiposJson.data?.classificados?.find((t) =>
        t.tipo.toLowerCase().includes('readmiss')
      );
      tipoReadmissaoId = tipo?.id ?? null;
    }
    if (!tipoReadmissaoId) {
      console.warn(
        '[Ocorrência] Tipo "Readmissão" não encontrado no Portal — ocorrência não registrada. ' +
        'Cadastre um tipo com a palavra "readmiss" no nome pra habilitar esse evento na timeline.'
      );
      return null;
    }

    const descDesligamento = params.dataDesligamentoAnterior
      ? formatarDataBr_(params.dataDesligamentoAnterior)
      : 'data desconhecida';

    const payload: CriarOcorrenciaPayload = {
      colaborador_id: colaboradorPortal.portalId,
      tipo_ocorrencia_id: tipoReadmissaoId,
      data_ocorrencia: params.dataReadmissao,
      descricao: `Colaborador readmitido após desligamento em ${descDesligamento}.`,
      origem: 'BluePoint - Admissão',
      usuario_criador_nome: 'BluePoint API (Automático)',
    };

    const response = await fetchComTimeout(
      `${PORTAL_BASE_URL}/api/external/ocorrencias`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PORTAL_API_KEY,
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.warn(
        `[Ocorrência] Portal retornou HTTP ${response.status} ao criar readmissão: ${text.substring(0, 200)}`
      );
      return null;
    }

    const data: OcorrenciaResponse = await response.json();
    if (data.success && data.data?.id) {
      console.warn(
        `[Ocorrência] ✓ Readmissão registrada: ocorrência #${data.data.id} ` +
        `- ${params.nomeColaborador} (CPF ${params.cpf})`
      );
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('[Ocorrência] Timeout ao registrar readmissão no Portal.');
    } else {
      console.error('[Ocorrência] Erro ao registrar readmissão no Portal:', error);
    }
    return null;
  }
}

function formatarDataBr_(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

// =====================================================
// ENVIAR JUSTIFICATIVA DE ATRASO AO PORTAL
// =====================================================

const MOTIVOS_LABELS: Record<string, string> = {
  transito: 'Trânsito',
  transporte_publico: 'Problema com transporte público',
  problema_saude: 'Problema de saúde',
  problema_familiar: 'Problema familiar',
  compromisso_medico: 'Compromisso médico',
  outros: 'Outros',
};

/**
 * Atualiza a ocorrência existente no Portal do Colaborador com a
 * justificativa de atraso enviada pelo colaborador.
 *
 * Usa PATCH /api/external/ocorrencias/:id diretamente no registro
 * já criado (o ID é armazenado em marcacoes.ocorrencia_portal_id
 * no momento em que a ocorrência é gerada).
 */
export async function enviarJustificativaAtrasoAoPortal(params: {
  ocorrenciaPortalId: number;
  motivo: string;
  justificativa: string;
}): Promise<boolean> {
  if (!PORTAL_API_KEY) {
    console.warn('[Ocorrência] PORTAL_COLABORADOR_API_KEY não configurada. Justificativa não enviada.');
    return false;
  }

  try {
    const motivoLabel = MOTIVOS_LABELS[params.motivo] || params.motivo;

    console.log(
      `[Ocorrência] Enviando justificativa para ocorrência #${params.ocorrenciaPortalId} no Portal...`
    );

    const response = await fetchComTimeout(
      `${PORTAL_BASE_URL}/api/external/ocorrencias/${params.ocorrenciaPortalId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PORTAL_API_KEY,
        },
        body: JSON.stringify({
          observacao: `[Justificativa via BluePoint] Motivo: ${motivoLabel}. ${params.justificativa}`,
        }),
      }
    );

    if (response.ok) {
      console.log(
        `[Ocorrência] ✓ Justificativa inserida na ocorrência #${params.ocorrenciaPortalId} do Portal`
      );
      return true;
    }

    const text = await response.text();
    console.warn(
      `[Ocorrência] PATCH retornou HTTP ${response.status} para ocorrência #${params.ocorrenciaPortalId}: ${text.substring(0, 200)}`
    );
    return false;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(
        `[Ocorrência] Timeout ao enviar justificativa ao Portal (${SERVICE_TIMEOUT}ms)`
      );
    } else {
      console.error('[Ocorrência] Erro ao enviar justificativa ao Portal:', error);
    }
    return false;
  }
}

// =====================================================
// ASSIDUIDADE - Busca de Pontos de Ocorrência
// =====================================================
// Funções para o módulo de assiduidade: consulta ocorrências
// do Portal e calcula a soma de gravidades por colaborador/mês.
// =====================================================

import type { BuscarPontosFn } from './assiduidade';

export interface PontosColaborador {
  total_pontos: number;
  ocorrencias_periodo: number;
}

const PONTOS_ZERO: PontosColaborador = { total_pontos: 0, ocorrencias_periodo: 0 };

interface OcorrenciaListItem {
  id: number;
  colaborador_id: number;
  data_ocorrencia: string;
  gravidade: number | null;
}

interface ListaOcorrenciasResponse {
  success: boolean;
  data: OcorrenciaListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean };
}

function formatarDataAssiduidade(ano: number, mes: number, dia: number): string {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

async function fetchOcorrenciasPaginado(
  params: Record<string, string>,
): Promise<OcorrenciaListItem[]> {
  const todas: OcorrenciaListItem[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = new URL(`${PORTAL_BASE_URL}/api/external/ocorrencias`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    url.searchParams.set('limit', '200');
    url.searchParams.set('page', String(page));

    const res = await fetchComTimeout(url.toString(), {
      method: 'GET',
      headers: { 'X-API-Key': PORTAL_API_KEY },
    });

    if (!res.ok) {
      throw new Error(`API externa de ocorrencias retornou HTTP ${res.status}`);
    }

    const json: ListaOcorrenciasResponse = await res.json();
    todas.push(...json.data);
    hasNext = json.pagination?.hasNext ?? false;
    page++;
  }

  return todas;
}

/**
 * Busca todas as ocorrencias de um mes/ano e retorna mapa
 * agrupado por colaborador_id com soma de gravidades.
 */
export async function buscarPontosMes(
  mes: number,
  ano: number,
): Promise<Map<number, PontosColaborador>> {
  const primeiroDia = formatarDataAssiduidade(ano, mes, 1);
  const ultimoDiaNum = new Date(ano, mes, 0).getDate();
  const ultimoDia = formatarDataAssiduidade(ano, mes, ultimoDiaNum);

  const ocorrencias = await fetchOcorrenciasPaginado({
    data_inicio: primeiroDia,
    data_fim: ultimoDia,
  });

  const mapa = new Map<number, PontosColaborador>();
  for (const oc of ocorrencias) {
    const grav = oc.gravidade ?? 0;
    const existing = mapa.get(oc.colaborador_id);
    if (existing) {
      existing.total_pontos += grav;
      existing.ocorrencias_periodo += 1;
    } else {
      mapa.set(oc.colaborador_id, { total_pontos: grav, ocorrencias_periodo: 1 });
    }
  }

  return mapa;
}

/**
 * Busca ocorrencias de um colaborador especifico num mes/ano.
 */
export async function buscarPontosColaboradorMes(
  colaboradorId: number,
  mes: number,
  ano: number,
): Promise<PontosColaborador> {
  const primeiroDia = formatarDataAssiduidade(ano, mes, 1);
  const ultimoDiaNum = new Date(ano, mes, 0).getDate();
  const ultimoDia = formatarDataAssiduidade(ano, mes, ultimoDiaNum);

  const ocorrencias = await fetchOcorrenciasPaginado({
    data_inicio: primeiroDia,
    data_fim: ultimoDia,
    colaborador_id: String(colaboradorId),
  });

  let totalPontos = 0;
  for (const oc of ocorrencias) {
    totalPontos += oc.gravidade ?? 0;
  }

  return { total_pontos: totalPontos, ocorrencias_periodo: ocorrencias.length };
}

/**
 * Cria uma funcao BuscarPontosFn com cache interno.
 * Para o mes pre-carregado, usa o mapa fornecido (eficiente para batch).
 * Para outros meses, busca por colaborador sob demanda (eficiente para cadeia).
 */
export function criarBuscadorPontos(options?: {
  pontosPreCarregados?: Map<number, PontosColaborador>;
  mesPreCarregado?: number;
  anoPreCarregado?: number;
}): BuscarPontosFn {
  const cache = new Map<string, PontosColaborador>();

  return async (colaboradorId, mes, ano) => {
    if (
      options?.pontosPreCarregados &&
      mes === options.mesPreCarregado &&
      ano === options.anoPreCarregado
    ) {
      return options.pontosPreCarregados.get(colaboradorId) ?? PONTOS_ZERO;
    }

    const chave = `${colaboradorId}-${mes}-${ano}`;
    if (cache.has(chave)) {
      return cache.get(chave)!;
    }

    const pontos = await buscarPontosColaboradorMes(colaboradorId, mes, ano);
    cache.set(chave, pontos);
    return pontos;
  };
}
