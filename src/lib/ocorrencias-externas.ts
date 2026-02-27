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
            `UPDATE bluepoint.bt_marcacoes SET ocorrencia_portal_id = $1 WHERE id = $2`,
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
 * já criado (o ID é armazenado em bt_marcacoes.ocorrencia_portal_id
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
