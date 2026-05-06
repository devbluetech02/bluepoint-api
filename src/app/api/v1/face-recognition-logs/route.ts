import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  paginatedSuccessResponse,
  serverErrorResponse,
  getPaginationParams,
} from '@/lib/api-response';
import { withPermission } from '@/lib/middleware';

/**
 * GET /api/v1/face-recognition-logs
 *
 * Listagem paginada da tabela people.face_recognition_logs com filtros.
 * Restrita à permissão `auditoria:face_logs:ver` (default: nível 3+).
 *
 * Filtros (querystring):
 *   pagina, limite          paginação padrão
 *   evento                  ex.: AMBIGUOUS_MATCH, MATCH_REJECTED_BY_USER
 *   colaboradorIdProposto   integer
 *   colaboradorIdConfirmado integer
 *   dispositivoCodigo       string
 *   origem                  totem | app | web | etc
 *   de, ate                 ISO date (yyyy-mm-dd) — janela em data_hora
 *   busca                   substring em razao da LLM, motivo, etc
 */
export async function GET(request: NextRequest) {
  return withPermission(request, 'auditoria:face_logs:ver', async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const evento = searchParams.get('evento');
      const colabPropostoRaw = searchParams.get('colaboradorIdProposto');
      const colabConfirmadoRaw = searchParams.get('colaboradorIdConfirmado');
      const dispositivoCodigo = searchParams.get('dispositivoCodigo');
      const origem = searchParams.get('origem');
      const de = searchParams.get('de');
      const ate = searchParams.get('ate');
      const busca = searchParams.get('busca');

      const where: string[] = [];
      const params: unknown[] = [];
      let i = 1;

      if (evento) {
        where.push(`l.evento = $${i++}`);
        params.push(evento);
      }
      if (colabPropostoRaw) {
        const id = parseInt(colabPropostoRaw, 10);
        if (!Number.isNaN(id)) {
          where.push(`l.colaborador_id_proposto = $${i++}`);
          params.push(id);
        }
      }
      if (colabConfirmadoRaw) {
        const id = parseInt(colabConfirmadoRaw, 10);
        if (!Number.isNaN(id)) {
          where.push(`l.colaborador_id_confirmado = $${i++}`);
          params.push(id);
        }
      }
      if (dispositivoCodigo) {
        where.push(`l.dispositivo_codigo = $${i++}`);
        params.push(dispositivoCodigo.toUpperCase());
      }
      if (origem) {
        where.push(`l.origem = $${i++}`);
        params.push(origem);
      }
      if (de) {
        where.push(`l.data_hora >= $${i++}::date`);
        params.push(de);
      }
      if (ate) {
        where.push(`l.data_hora < ($${i++}::date + interval '1 day')`);
        params.push(ate);
      }
      if (busca) {
        where.push(`(
          COALESCE(l.llm_razao, '') ILIKE $${i} OR
          COALESCE(l.metadados::text, '') ILIKE $${i} OR
          COALESCE(cp.nome, '') ILIKE $${i} OR
          COALESCE(cc.nome, '') ILIKE $${i}
        )`);
        params.push(`%${busca}%`);
        i++;
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      // Total
      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
           FROM people.face_recognition_logs l
           LEFT JOIN people.colaboradores cp
             ON cp.id = l.colaborador_id_proposto
           LEFT JOIN people.colaboradores cc
             ON cc.id = l.colaborador_id_confirmado
          ${whereClause}`,
        params,
      );
      const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT
           l.id,
           l.evento,
           l.data_hora,
           l.endpoint,
           l.origem,
           l.ip,
           l.dispositivo_codigo,
           l.latitude,
           l.longitude,
           l.colaborador_id_proposto,
           l.colaborador_id_confirmado,
           cp.nome AS proposto_nome,
           cc.nome AS confirmado_nome,
           l.distancia_top1,
           l.distancia_top2,
           l.gap_top12,
           l.threshold_efetivo,
           l.qualidade,
           l.qualidade_detalhada,
           l.llm_modelo,
           l.llm_confirmou,
           l.llm_confidence,
           l.llm_razao,
           l.llm_latency_ms,
           l.foto_url,
           l.duracao_ms,
           l.marcacao_id,
           l.metadados
         FROM people.face_recognition_logs l
         LEFT JOIN people.colaboradores cp
           ON cp.id = l.colaborador_id_proposto
         LEFT JOIN people.colaboradores cc
           ON cc.id = l.colaborador_id_confirmado
         ${whereClause}
         ORDER BY l.data_hora DESC
         LIMIT $${i++} OFFSET $${i++}`,
        dataParams,
      );

      const dados = result.rows.map((row) => ({
        id: Number(row.id),
        evento: row.evento,
        dataHora: row.data_hora,
        endpoint: row.endpoint,
        origem: row.origem,
        ip: row.ip,
        dispositivoCodigo: row.dispositivo_codigo,
        latitude: row.latitude !== null ? Number(row.latitude) : null,
        longitude: row.longitude !== null ? Number(row.longitude) : null,
        colaboradorIdProposto: row.colaborador_id_proposto,
        colaboradorIdConfirmado: row.colaborador_id_confirmado,
        propostoNome: row.proposto_nome,
        confirmadoNome: row.confirmado_nome,
        distanciaTop1: row.distancia_top1 !== null ? Number(row.distancia_top1) : null,
        distanciaTop2: row.distancia_top2 !== null ? Number(row.distancia_top2) : null,
        gapTop12: row.gap_top12 !== null ? Number(row.gap_top12) : null,
        thresholdEfetivo: row.threshold_efetivo !== null ? Number(row.threshold_efetivo) : null,
        qualidade: row.qualidade !== null ? Number(row.qualidade) : null,
        qualidadeDetalhada: row.qualidade_detalhada,
        llmModelo: row.llm_modelo,
        llmConfirmou: row.llm_confirmou,
        llmConfidence: row.llm_confidence !== null ? Number(row.llm_confidence) : null,
        llmRazao: row.llm_razao,
        llmLatencyMs: row.llm_latency_ms,
        fotoUrl: row.foto_url,
        duracaoMs: row.duracao_ms,
        marcacaoId: row.marcacao_id,
        metadados: row.metadados,
      }));

      return paginatedSuccessResponse(dados, total, pagina, limite);
    } catch (e) {
      console.error('[face-recognition-logs] erro:', e);
      return serverErrorResponse('Erro ao listar logs de reconhecimento facial');
    }
  });
}
