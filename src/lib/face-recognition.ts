/**
 * Face Recognition Library - InsightFace/ArcFace via microserviço Python
 * 
 * Toda a lógica de IA roda no microserviço Python (InsightFace + ONNX Runtime).
 * Esta lib apenas faz chamadas HTTP ao serviço e expõe funções compatíveis
 * com a interface anterior para minimizar mudanças nos endpoints.
 */

// ==========================================
// CONFIGURAÇÃO
// ==========================================

// URL do microserviço Python (configurável via env)
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://face-service:5000';

// Threshold para match (distância coseno)
// ArcFace é muito mais estável que face-api.js:
// - Mesma pessoa, mesma câmera: ~0.0-0.15
// - Mesma pessoa, câmeras diferentes: ~0.15-0.30
// - Pessoas DIFERENTES: tipicamente >0.45
// Histórico real (logs prod 2026-05-05): falsos negativos para mesma
// pessoa cadastrada via portal externo ficaram em 0.405-0.415 —
// gap < 0.02 do antigo threshold 0.40. Outras pessoas no mesmo dia
// ficaram 0.65-0.85. 0.45 mantém margem ampla contra falsos positivos
// e elimina o "Rosto não reconhecido" para quem está cadastrado.
const MATCH_THRESHOLD = 0.45;

// Timeout para chamadas ao serviço (ms)
// /extract p99 real ≈ 500ms. 8s cobre picos sem enfileirar requests que
// travariam o health-check do container.
const SERVICE_TIMEOUT = 8000;

// Circuit breaker — se o microserviço engasgar, falha rápido em vez de
// segurar requests pendurando 8s cada e derrubando o health-check da task.
const CB_FAILURE_THRESHOLD = 5;   // falhas consecutivas para abrir
const CB_OPEN_DURATION_MS = 30_000; // quanto tempo fica aberto
let cbFailures = 0;
let cbOpenedAt = 0;

function cbIsOpen(): boolean {
  if (cbOpenedAt === 0) return false;
  if (Date.now() - cbOpenedAt >= CB_OPEN_DURATION_MS) {
    // half-open: permite próxima tentativa para sondar recuperação
    cbOpenedAt = 0;
    cbFailures = 0;
    return false;
  }
  return true;
}

function cbRecordFailure(): void {
  cbFailures += 1;
  if (cbFailures >= CB_FAILURE_THRESHOLD && cbOpenedAt === 0) {
    cbOpenedAt = Date.now();
    console.warn(`[Face Recognition] Circuit breaker aberto após ${cbFailures} falhas consecutivas`);
  }
}

function cbRecordSuccess(): void {
  if (cbFailures > 0 || cbOpenedAt !== 0) {
    cbFailures = 0;
    cbOpenedAt = 0;
  }
}

// ==========================================
// TIPOS
// ==========================================

interface ExtractResult {
  encoding: Float32Array | null;
  qualidade: number;
  qualidadeDetalhada?: {
    scoreDeteccao: number;
    tamanhoFace: number;
    centralizacao: number;
  };
  error?: string;
}

interface ServiceExtractResponse {
  success: boolean;
  embedding?: number[];
  dimensions?: number;
  quality?: number;
  qualityDetails?: {
    detScore: number;
    sizeScore: number;
    centerScore: number;
  };
  bbox?: number[];
  imageSize?: { width: number; height: number };
  totalFaces?: number;
  processedIn?: number;
  error?: string;
  code?: string;
}

// ==========================================
// FUNÇÕES DE COMUNICAÇÃO COM O SERVIÇO
// ==========================================

/**
 * Faz uma chamada HTTP ao microserviço Python
 */
async function callFaceService<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  if (cbIsOpen()) {
    throw new Error('Face service unavailable (circuit breaker open)');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);

  try {
    const response = await fetch(`${FACE_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.detail || `Face service error: ${response.status}`);
    }

    const result = await response.json() as T;
    cbRecordSuccess();
    return result;
  } catch (error) {
    cbRecordFailure();
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Face service timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ==========================================
// FUNÇÕES PÚBLICAS (interface compatível)
// ==========================================

/**
 * Extrai o encoding facial de uma imagem via microserviço InsightFace
 * Retorna embedding de 512 dimensões (ArcFace)
 */
export async function extractFaceEncoding(imageBase64: string): Promise<ExtractResult> {
  try {
    const result = await callFaceService<ServiceExtractResponse>('/extract', {
      imagem: imageBase64,
    });

    if (!result.success || !result.embedding) {
      return {
        encoding: null,
        qualidade: 0,
        error: result.error || 'Nenhuma face detectada na imagem',
      };
    }

    const encoding = new Float32Array(result.embedding);

    console.log(`[Face Recognition] Qualidade: ${result.quality}, Dimensões: ${result.dimensions}, ` +
      `Faces: ${result.totalFaces}, Tempo: ${result.processedIn}ms`);

    return {
      encoding,
      qualidade: result.quality || 0,
      qualidadeDetalhada: result.qualityDetails ? {
        scoreDeteccao: result.qualityDetails.detScore,
        tamanhoFace: result.qualityDetails.sizeScore,
        centralizacao: result.qualityDetails.centerScore,
      } : undefined,
    };
  } catch (error) {
    console.error('[Face Recognition] Erro ao extrair encoding:', error);
    return {
      encoding: null,
      qualidade: 0,
      error: `Erro ao processar imagem: ${error instanceof Error ? error.message : error}`,
    };
  }
}

/**
 * Compara dois encodings usando distância coseno
 * Retorna a distância (0 = idêntico, 2 = oposto)
 */
export async function compareFaces(
  encoding1: Float32Array,
  encoding2: Float32Array
): Promise<number> {
  // Calcular distância coseno localmente (é simples e não precisa do serviço)
  const dot = encoding1.reduce((sum, val, i) => sum + val * encoding2[i], 0);
  const norm1 = Math.sqrt(encoding1.reduce((sum, val) => sum + val * val, 0));
  const norm2 = Math.sqrt(encoding2.reduce((sum, val) => sum + val * val, 0));
  const similarity = dot / (norm1 * norm2);
  return 1 - similarity; // distância coseno
}

/**
 * Verifica se a distância está dentro do threshold de match
 */
export function isMatch(distance: number, threshold?: number): boolean {
  return distance < (threshold ?? MATCH_THRESHOLD);
}

/**
 * Encontra o melhor match em uma lista de encodings
 */
export async function findBestMatch(
  targetEncoding: Float32Array,
  encodings: Array<{ colaboradorId: number; encoding: Float32Array }>,
  threshold?: number
): Promise<{ colaboradorId: number; distance: number } | null> {
  const effectiveThreshold = threshold ?? MATCH_THRESHOLD;
  let bestMatch: { colaboradorId: number; distance: number } | null = null;

  for (const item of encodings) {
    const distance = await compareFaces(targetEncoding, item.encoding);

    if (distance < effectiveThreshold) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { colaboradorId: item.colaboradorId, distance };
      }
    }
  }

  return bestMatch;
}

/**
 * Encontra o melhor match em uma lista de encodings (versão genérica)
 */
export async function findBestMatchGeneric<T extends { encoding: Float32Array }>(
  targetEncoding: Float32Array,
  encodings: T[],
  threshold?: number
): Promise<{ match: T; distance: number; index: number } | null> {
  const effectiveThreshold = threshold ?? MATCH_THRESHOLD;
  let bestMatch: { match: T; distance: number; index: number } | null = null;
  let menorDistancia = Infinity;

  for (let i = 0; i < encodings.length; i++) {
    const item = encodings[i];
    const distance = await compareFaces(targetEncoding, item.encoding);

    if (distance < menorDistancia) {
      menorDistancia = distance;
    }

    if (distance < effectiveThreshold) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { match: item, distance, index: i };
      }
    }
  }

  if (bestMatch) {
    console.log(`[findBestMatch] MATCH! Distância: ${bestMatch.distance.toFixed(4)}, Threshold: ${effectiveThreshold.toFixed(3)}`);
  } else {
    console.log(`[findBestMatch] Sem match. Menor distância: ${menorDistancia.toFixed(4)}, Threshold: ${effectiveThreshold.toFixed(3)}, Gap: ${(menorDistancia - effectiveThreshold).toFixed(4)}`);
  }

  return bestMatch;
}

/**
 * Procura as N pessoas mais próximas, agrupando encodings por pessoa.
 *
 * Quando temos múltiplos encodings por pessoa (principal + extras +
 * aprendidos), `findBestMatchGeneric` retorna apenas o melhor encoding
 * — sem nos dizer qual a SEGUNDA pessoa mais próxima. Isso é crítico
 * para detectar matches ambíguos (duas pessoas com distâncias
 * praticamente iguais).
 *
 * Aqui agrupamos por chave de pessoa (`personKey(item)`) e retornamos
 * top-N pessoas, cada uma com sua MENOR distância (best encoding).
 */
export interface PersonMatch<T> {
  key: string;
  match: T;
  distance: number;
}

export async function findTopMatchesByPerson<T extends { encoding: Float32Array }>(
  targetEncoding: Float32Array,
  encodings: T[],
  personKey: (item: T) => string,
  topN: number = 3,
): Promise<PersonMatch<T>[]> {
  const bestPerKey = new Map<string, PersonMatch<T>>();

  for (const item of encodings) {
    const distance = await compareFaces(targetEncoding, item.encoding);
    const key = personKey(item);
    const current = bestPerKey.get(key);
    if (!current || distance < current.distance) {
      bestPerKey.set(key, { key, match: item, distance });
    }
  }

  const sorted = Array.from(bestPerKey.values()).sort(
    (a, b) => a.distance - b.distance,
  );
  return sorted.slice(0, topN);
}

/**
 * Converte Float32Array para Buffer (para salvar no banco)
 */
export function encodingToBuffer(encoding: Float32Array): Buffer {
  return Buffer.from(encoding.buffer);
}

/**
 * Converte Buffer para Float32Array (para ler do banco)
 */
export function bufferToEncoding(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

/**
 * Obtém o threshold padrão de match
 */
export function getMatchThreshold(): number {
  return MATCH_THRESHOLD;
}

/**
 * Calcula threshold dinâmico baseado na qualidade
 * Com ArcFace, o threshold é muito mais estável - variação mínima
 */
export function calcularThresholdDinamico(qualidade: number): number {
  // Threshold adaptativo: quanto pior a qualidade, mais flexível o
  // threshold. MATCH_THRESHOLD base = 0.45. Degraus mantêm margem
  // segura contra falsos positivos (pessoas diferentes ficam 0.55+
  // tipicamente), evitando inflar o teto além de 0.55.
  if (qualidade >= 0.7) return MATCH_THRESHOLD;         // ótima: 0.45
  if (qualidade >= 0.5) return MATCH_THRESHOLD + 0.02;  // boa: 0.47
  if (qualidade >= 0.3) return MATCH_THRESHOLD + 0.05;  // baixa: 0.50
  if (qualidade >= 0.15) return MATCH_THRESHOLD + 0.07; // muito baixa: 0.52
  return MATCH_THRESHOLD + 0.10;                        // limite: 0.55
}

// ==========================================
// AUTO-APRENDIZADO
// ==========================================

// Máximo de encodings aprendidos por pessoa.
// Reduzido de 40 → 20 após incidente de contaminação (caso EDUARDO
// NATANAEL com 47 aprendidos: aparecia como Top1/Top2 pra várias
// pessoas diferentes em distâncias <0.30 — cluster expandido demais).
const MAX_ENCODINGS_APRENDIDOS = 20;

// Distância mínima entre encodings p/ considerar "diverso" (evita redundância).
// Subido de 0.04 → 0.08: encoding novo precisa trazer informação real,
// não micro-variação que só infla o cluster.
const DIVERSIDADE_MINIMA = 0.08;

// Confiança mínima para auto-aprender (distância máxima aceita).
// Apertado de 0.42 → 0.28: só aprende de matches MUITO confiantes
// (mesma pessoa, mesma câmera, ~zero ambiguidade). 0.42 era praticamente
// o threshold de match (0.45) — qualquer match-no-limite virava
// aprendizado e contaminava o cluster.
const AUTO_APRENDER_MAX_DISTANCIA = 0.28;

// Qualidade mínima da imagem p/ auto-aprender.
// Subido de 0.12 → 0.50: foto borrada/escura nunca devia virar
// referência — só piora o cluster.
const AUTO_APRENDER_MIN_QUALIDADE = 0.50;

/**
 * Verifica se um encoding é suficientemente diverso em relação aos existentes.
 * Retorna true se o encoding traz informação nova (diferente ângulo, luz, etc).
 * 
 * @param novoEncoding - Encoding a ser avaliado
 * @param encodingsExistentes - Lista de encodings já armazenados
 * @returns { diverso: boolean, menorDistancia: number }
 */
export async function verificarDiversidade(
  novoEncoding: Float32Array,
  encodingsExistentes: Float32Array[]
): Promise<{ diverso: boolean; menorDistancia: number }> {
  if (encodingsExistentes.length === 0) {
    return { diverso: true, menorDistancia: Infinity };
  }

  let menorDistancia = Infinity;

  for (const existente of encodingsExistentes) {
    const distancia = await compareFaces(novoEncoding, existente);
    if (distancia < menorDistancia) {
      menorDistancia = distancia;
    }
  }

  // Se a menor distância é maior que o limiar, o encoding é diverso
  return {
    diverso: menorDistancia >= DIVERSIDADE_MINIMA,
    menorDistancia,
  };
}

/**
 * Verifica se as condições para auto-aprendizado são atendidas.
 * 
 * @param distanciaMatch - Distância do match encontrado
 * @param qualidade - Qualidade da imagem
 * @param totalAprendidos - Total de encodings já aprendidos
 * @returns { deveAprender: boolean, motivo?: string }
 */
export function verificarCondicoesAutoAprendizado(
  distanciaMatch: number,
  qualidade: number,
  totalAprendidos: number
): { deveAprender: boolean; motivo?: string } {
  // Match com confiança alta o suficiente?
  if (distanciaMatch > AUTO_APRENDER_MAX_DISTANCIA) {
    return { 
      deveAprender: false, 
      motivo: `Distância ${distanciaMatch.toFixed(4)} acima do limite ${AUTO_APRENDER_MAX_DISTANCIA}` 
    };
  }

  // Qualidade da imagem suficiente?
  if (qualidade < AUTO_APRENDER_MIN_QUALIDADE) {
    return { 
      deveAprender: false, 
      motivo: `Qualidade ${qualidade} abaixo do mínimo ${AUTO_APRENDER_MIN_QUALIDADE}` 
    };
  }

  // Ainda tem espaço para mais encodings?
  if (totalAprendidos >= MAX_ENCODINGS_APRENDIDOS) {
    return { 
      deveAprender: false, 
      motivo: `Limite de ${MAX_ENCODINGS_APRENDIDOS} encodings aprendidos atingido` 
    };
  }

  return { deveAprender: true };
}

/**
 * Retorna o índice do encoding de menor qualidade no array.
 * Útil para substituir o pior encoding quando o limite é atingido.
 */
export function encontrarPiorEncoding(qualidades: number[]): number {
  if (qualidades.length === 0) return -1;
  
  let piorIdx = 0;
  let piorQualidade = qualidades[0];

  for (let i = 1; i < qualidades.length; i++) {
    if (qualidades[i] < piorQualidade) {
      piorQualidade = qualidades[i];
      piorIdx = i;
    }
  }

  return piorIdx;
}

/**
 * Obtém as constantes de auto-aprendizado (para uso externo)
 */
export function getAutoAprendizadoConfig() {
  return {
    maxEncodings: MAX_ENCODINGS_APRENDIDOS,
    diversidadeMinima: DIVERSIDADE_MINIMA,
    maxDistanciaMatch: AUTO_APRENDER_MAX_DISTANCIA,
    minQualidade: AUTO_APRENDER_MIN_QUALIDADE,
  };
}

/**
 * Verifica se o serviço de reconhecimento facial está disponível
 */
export async function checkFaceServiceHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${FACE_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    return data.ready === true;
  } catch {
    return false;
  }
}
