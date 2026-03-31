/**
 * Geração de embeddings para novas linhas (coluna embedding em tabelas do schema people).
 * Usa OPENAI_API_KEY e opcionalmente OPENAI_API_BASE_URL (ex.: OpenRouter).
 *
 * Para qualquer rota ou lib que faça INSERT em tabela do schema people com coluna embedding,
 * chame embedTableRowAfterInsert('nome_tabela', idRetornado) após o INSERT (ou em background
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

/** Tabelas do schema people que possuem coluna embedding (para não consultar info_schema em todo request) */
const TABLES_WITH_EMBEDDING = new Set([
  'alertas_inteligentes', 'anexos', 'api_keys', 'api_keys_log', 'atrasos_tolerados',
  'auditoria', 'banco_horas', 'biometria_facial', 'cargos', 'codigos_exportacao',
  'colaborador_jornadas_historico', 'colaboradores', 'config_relatorio_personalizado',
  'config_sistema', 'configuracoes', 'configuracoes_empresa', 'contratos_prestador',
  'custo_horas_extras', 'departamentos', 'dispositivos', 'documentos_colaborador',
  'empresas', 'feriados', 'fotos_reconhecimento', 'historico_assiduidade',
  'historico_tolerancia_hora_extra', 'horas_extras_consolidado', 'jornada_horarios',
  'jornadas', 'liderancas_departamento', 'limites_he_departamentos', 'limites_he_empresas',
  'limites_he_gestores', 'localizacao_departamentos', 'localizacoes', 'marcacoes',
  'mapeamento_tabelas_colunas', 'modelos_exportacao', 'nfes_prestador', 'notificacoes',
  'parametros_assiduidade', 'parametros_beneficios', 'parametros_hora_extra', 'parametros_tolerancia_atraso',
  'periodos_ferias', 'permissoes', 'prestadores', 'refresh_tokens', 'relatorios_mensais',
  'solicitacoes', 'solicitacoes_historico', 'solicitacoes_horas_extras', 'tipo_usuario_permissoes',
  'tipos_solicitacao', 'tokens_recuperacao',
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
  const table = tableName.startsWith('') ? tableName : `${tableName}`;
  if (!TABLES_WITH_EMBEDDING.has(table)) return;

  let client;
  try {
    client = await getClient();
    await client.query('SET search_path TO people, public');

    const colsResult = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'people' AND table_name = $1
         AND column_name <> 'embedding' AND data_type NOT IN ('bytea', 'USER-DEFINED')
       ORDER BY ordinal_position`,
      [table]
    );
    const columns = colsResult.rows.map((r) => r.column_name as string);
    if (columns.length === 0) return;

    const colList = columns.map((c) => `"${c}"`).join(', ');
    const rowResult = await client.query(
      `SELECT ${colList} FROM people."${table}" WHERE "${idColumn}" = $1`,
      [id]
    );
    if (rowResult.rows.length === 0) return;

    const row = rowResult.rows[0] as Record<string, unknown>;
    const text = rowToText(row, columns);
    const embedding = await generateEmbedding(text);
    const vecStr = `[${embedding.join(',')}]`;

    await client.query(
      `UPDATE people."${table}" SET embedding = $1::vector WHERE "${idColumn}" = $2`,
      [vecStr, id]
    );
  } catch (err) {
    console.warn(`[embeddings] Falha ao gerar embedding para ${table}.${idColumn}=${id}:`, err);
  } finally {
    client?.release();
  }
}
