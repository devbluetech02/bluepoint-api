/**
 * Logger de eventos do reconhecimento facial.
 *
 * Insere em people.face_recognition_logs (migration 061). É chamado
 * dos endpoints /biometria/verificar-face, /tiebreak-face,
 * /tiebreak-confirmar e do endpoint dedicado de feedback do cliente
 * (botões "Não sou eu" / "Sim sou eu" no totem).
 *
 * Best-effort: erros de inserção só caem no console, NÃO bloqueiam
 * a resposta principal. O objetivo é coleta pra análise — perder
 * uma linha aqui é melhor do que segurar o registro de ponto.
 */

import { query } from './db';
import { uploadArquivo } from './storage';

export type FaceEventType =
  | 'FACE_NOT_DETECTED'
  | 'LOW_QUALITY'
  | 'NO_FACES_REGISTERED'
  | 'NOT_IDENTIFIED'
  | 'AMBIGUOUS_MATCH'
  | 'LLM_REJECTED'
  | 'INACTIVE_COLLABORATOR'
  | 'MATCH_PROPOSED'
  | 'MATCH_CONFIRMED'
  | 'MATCH_REJECTED_BY_USER'
  | 'LOGIN_BY_FACE'
  | 'TIEBREAK_PROPOSED'
  | 'TIEBREAK_NO_MATCH'
  | 'TIEBREAK_CONFIRMED'
  | 'TIEBREAK_REJECTED_BY_USER'
  | 'NEAR_MISS_RECOVERED'
  | 'NEAR_MISS_NOT_RECOVERED'
  | 'INTERNAL_ERROR';

export type FaceEndpoint =
  | 'verificar-face'
  | 'tiebreak-face'
  | 'tiebreak-confirmar'
  | 'feedback';

export interface FaceLogPayload {
  evento: FaceEventType;
  origem?: string | null;
  endpoint: FaceEndpoint;
  ip?: string | null;
  userAgent?: string | null;
  dispositivoCodigo?: string | null;
  latitude?: number | null;
  longitude?: number | null;

  colaboradorIdProposto?: number | null;
  colaboradorIdConfirmado?: number | null;
  externalIdProposto?: Record<string, string> | null;
  distanciaTop1?: number | null;
  distanciaTop2?: number | null;
  gapTop12?: number | null;
  thresholdEfetivo?: number | null;

  qualidade?: number | null;
  qualidadeDetalhada?: Record<string, unknown> | null;

  llmModelo?: string | null;
  llmConfirmou?: boolean | null;
  llmConfidence?: number | null;
  llmRazao?: string | null;
  llmLatencyMs?: number | null;

  fotoUrl?: string | null;
  duracaoMs?: number | null;
  marcacaoId?: number | null;

  metadados?: Record<string, unknown> | null;
}

/**
 * Sobe a imagem capturada (data URI ou base64) para o MinIO em pasta
 * dedicada de logs faciais e devolve a URL pública. Compartilhado por
 * todos os endpoints que registram em face_recognition_logs (verificar-
 * face, tiebreak-*). Best-effort — falha → null sem propagar erro.
 */
export async function uploadFotoFaceLog(
  imagem: string,
  evento: string,
  dispositivoCodigo?: string,
): Promise<string | null> {
  try {
    const base64 = imagem.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) return null;
    const isPng = imagem.startsWith('data:image/png');
    const ext = isPng ? 'png' : 'jpg';
    const ct = isPng ? 'image/png' : 'image/jpeg';
    const dataDir = new Date().toISOString().split('T')[0];
    const ts = Date.now();
    const deviceTag = (dispositivoCodigo || 'sem-codigo').replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );
    const path = `face-logs/${dataDir}/${deviceTag}/${ts}_${evento.toLowerCase()}.${ext}`;
    return await uploadArquivo(path, buffer, ct);
  } catch (e) {
    console.warn('[uploadFotoFaceLog] falha:', e);
    return null;
  }
}

export async function logFaceEvent(payload: FaceLogPayload): Promise<number | null> {
  try {
    const r = await query<{ id: string }>(
      `INSERT INTO people.face_recognition_logs (
        evento, origem, endpoint, ip, user_agent, dispositivo_codigo,
        latitude, longitude,
        colaborador_id_proposto, colaborador_id_confirmado, external_id_proposto,
        distancia_top1, distancia_top2, gap_top12, threshold_efetivo,
        qualidade, qualidade_detalhada,
        llm_modelo, llm_confirmou, llm_confidence, llm_razao, llm_latency_ms,
        foto_url, duracao_ms, marcacao_id, metadados
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17,
        $18, $19, $20, $21, $22,
        $23, $24, $25, $26
      ) RETURNING id::text`,
      [
        payload.evento,
        payload.origem ?? null,
        payload.endpoint,
        payload.ip ?? null,
        payload.userAgent ?? null,
        payload.dispositivoCodigo ?? null,
        payload.latitude ?? null,
        payload.longitude ?? null,
        payload.colaboradorIdProposto ?? null,
        payload.colaboradorIdConfirmado ?? null,
        payload.externalIdProposto ? JSON.stringify(payload.externalIdProposto) : null,
        payload.distanciaTop1 ?? null,
        payload.distanciaTop2 ?? null,
        payload.gapTop12 ?? null,
        payload.thresholdEfetivo ?? null,
        payload.qualidade ?? null,
        payload.qualidadeDetalhada ? JSON.stringify(payload.qualidadeDetalhada) : null,
        payload.llmModelo ?? null,
        payload.llmConfirmou ?? null,
        payload.llmConfidence ?? null,
        payload.llmRazao ?? null,
        payload.llmLatencyMs ?? null,
        payload.fotoUrl ?? null,
        payload.duracaoMs ?? null,
        payload.marcacaoId ?? null,
        payload.metadados ? JSON.stringify(payload.metadados) : null,
      ],
    );
    return r.rows[0]?.id ? Number(r.rows[0].id) : null;
  } catch (e) {
    console.error('[face-log] erro ao gravar evento (não bloqueante):', e);
    return null;
  }
}

/**
 * Helper "fire-and-forget" para uso dentro de handlers — agenda a
 * inserção mas não espera resposta, evitando latência adicional no
 * caminho crítico do registro de ponto.
 */
export function logFaceEventAsync(payload: FaceLogPayload): void {
  logFaceEvent(payload).catch((e) =>
    console.error('[face-log] erro async (não bloqueante):', e),
  );
}

/**
 * Atualiza um log existente — usado quando uma mesma sessão de
 * reconhecimento evolui de PROPOSED → CONFIRMED ou REJECTED. Evita
 * poluir a tabela com 2 linhas (uma por chamada).
 *
 * Best-effort: se o log não existir mais ou o update falhar, log de
 * warning e segue. Não bloqueia o fluxo principal.
 */
export async function updateFaceEvent(
  logId: number,
  patch: {
    evento?: FaceEventType;
    colaboradorIdConfirmado?: number | null;
    marcacaoId?: number | null;
    fotoUrl?: string | null;
    metadados?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.evento !== undefined) push('evento', patch.evento);
    if (patch.colaboradorIdConfirmado !== undefined)
      push('colaborador_id_confirmado', patch.colaboradorIdConfirmado);
    if (patch.marcacaoId !== undefined) push('marcacao_id', patch.marcacaoId);
    if (patch.fotoUrl !== undefined) push('foto_url', patch.fotoUrl);
    if (patch.metadados !== undefined)
      push('metadados', patch.metadados ? JSON.stringify(patch.metadados) : null);

    if (sets.length === 0) return;
    values.push(logId);
    await query(
      `UPDATE people.face_recognition_logs SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    );
  } catch (e) {
    console.warn('[face-log] update falhou (não bloqueante):', e);
  }
}
