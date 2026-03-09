/**
 * Geração de embeddings para novas linhas (coluna embedding em tabelas do schema bluepoint).
 * Usa OPENAI_API_KEY e opcionalmente OPENAI_API_BASE_URL (ex.: OpenRouter).
 *
 * Para qualquer rota ou lib que faça INSERT em tabela do schema bluepoint com coluna embedding,
 * chame embedTableRowAfterInsert('bt_nome_tabela', idRetornado) após o INSERT (ou em background
 * com .catch(() => {}) para não atrasar a resposta).
 */

import { getClient } from '@/lib/db';

const OPENAI_API_BASE_URL = (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const BASE_IS_OPENROUTER = OPENAI_API_BASE_URL.includes('openrouter');
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || (BASE_IS_OPENROUTER ? 'openai/text-embedding-3-small' : 'text-embedding-3-small');
const MAX_TEXT_LEN = 8000;

function rowToText(row: Record<string, unknown>, columns: string[]): string {
  const parts: string[] = [];
  for (const col of columns) {
    const v = row[col];
    if (v != null && typeof v === 'object' && !(v instanceof Date)) {
      try {
        parts.push(`${col}: ${JSON.stringify(v)}`);
      } catch {
        parts.push(`${col}: [object]`);
      }
    } else if (v != null) {
      parts.push(`${col}: ${String(v)}`);
    }
  }
  let text = parts.join(' | ');
  if (text.length > MAX_TEXT_LEN) text = text.slice(0, MAX_TEXT_LEN);
  return text || '(vazio)';
}

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY não definida');

  const url = `${OPENAI_API_BASE_URL}/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model: EMBEDDING_MODEL }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API embeddings: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }>; embeddings?: number[][] };
  const list = data?.data ?? data?.embeddings ?? (data as unknown as number[][]);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Resposta da API sem embeddings');
  }
  const first = list[0];
  return Array.isArray(first) ? first : (first as { embedding?: number[] }).embedding ?? [];
}

/** Tabelas do schema bluepoint que possuem coluna embedding (para não consultar info_schema em todo request) */
const TABLES_WITH_EMBEDDING = new Set([
  'bt_alertas_inteligentes', 'bt_anexos', 'bt_api_keys', 'bt_api_keys_log', 'bt_atrasos_tolerados',
  'bt_auditoria', 'bt_banco_horas', 'bt_biometria_facial', 'bt_cargos', 'bt_codigos_exportacao',
  'bt_colaborador_jornadas_historico', 'bt_colaboradores', 'bt_config_relatorio_personalizado',
  'bt_config_sistema', 'bt_configuracoes', 'bt_configuracoes_empresa', 'bt_contratos_prestador',
  'bt_custo_horas_extras', 'bt_departamentos', 'bt_dispositivos', 'bt_documentos_colaborador',
  'bt_empresas', 'bt_feriados', 'bt_fotos_reconhecimento', 'bt_historico_assiduidade',
  'bt_historico_tolerancia_hora_extra', 'bt_horas_extras_consolidado', 'bt_jornada_horarios',
  'bt_jornadas', 'bt_liderancas_departamento', 'bt_limites_he_departamentos', 'bt_limites_he_empresas',
  'bt_limites_he_gestores', 'bt_localizacao_departamentos', 'bt_localizacoes', 'bt_marcacoes',
  'bt_mapeamento_tabelas_colunas', 'bt_modelos_exportacao', 'bt_nfes_prestador', 'bt_notificacoes',
  'bt_parametros_assiduidade', 'bt_parametros_beneficios', 'bt_parametros_hora_extra', 'bt_parametros_tolerancia_atraso',
  'bt_periodos_ferias', 'bt_permissoes', 'bt_prestadores', 'bt_refresh_tokens', 'bt_relatorios_mensais',
  'bt_solicitacoes', 'bt_solicitacoes_historico', 'bt_solicitacoes_horas_extras', 'bt_tipo_usuario_permissoes',
  'bt_tipos_solicitacao', 'bt_tokens_recuperacao',
]);

/**
 * Gera o embedding para uma linha recém-criada e atualiza a coluna embedding.
 * Chamar após INSERT (com o id retornado). Não propaga erro para não falhar a resposta da API.
 */
export async function embedTableRowAfterInsert(
  tableName: string,
  id: number,
  idColumn: string = 'id'
): Promise<void> {
  if (!process.env.OPENAI_API_KEY) return;
  const table = tableName.startsWith('bt_') ? tableName : `bt_${tableName}`;
  if (!TABLES_WITH_EMBEDDING.has(table)) return;

  let client;
  try {
    client = await getClient();
    await client.query('SET search_path TO bluepoint, public');

    const colsResult = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'bluepoint' AND table_name = $1
         AND column_name <> 'embedding' AND data_type NOT IN ('bytea', 'USER-DEFINED')
       ORDER BY ordinal_position`,
      [table]
    );
    const columns = colsResult.rows.map((r) => r.column_name as string);
    if (columns.length === 0) return;

    const colList = columns.map((c) => `"${c}"`).join(', ');
    const rowResult = await client.query(
      `SELECT ${colList} FROM bluepoint."${table}" WHERE "${idColumn}" = $1`,
      [id]
    );
    if (rowResult.rows.length === 0) return;

    const row = rowResult.rows[0] as Record<string, unknown>;
    const text = rowToText(row, columns);
    const embedding = await generateEmbedding(text);
    const vecStr = `[${embedding.join(',')}]`;

    await client.query(
      `UPDATE bluepoint."${table}" SET embedding = $1::vector WHERE "${idColumn}" = $2`,
      [vecStr, id]
    );
  } catch (err) {
    console.warn(`[embeddings] Falha ao gerar embedding para ${table}.${idColumn}=${id}:`, err);
  } finally {
    client?.release();
  }
}
