#!/usr/bin/env node
/**
 * Popula a coluna embedding (vector 1536) em todas as tabelas do schema bluepoint.
 * Usa API de embeddings (OpenAI ou OpenRouter). Requer OPENAI_API_KEY no .env.
 * Se usar OpenRouter: OPENAI_API_BASE_URL=https://openrouter.ai/api/v1
 *
 * Uso: node scripts/populate-embeddings.mjs
 * (rode na pasta do projeto; carrega .env automaticamente)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Carregar .env
function loadEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  const env = readFileSync(envPath, 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}
loadEnv();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE_URL = (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USERNAME || 'bluepoint';
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_DATABASE || 'bluepoint_vector';

const BATCH_SIZE = 50;
const BASE_IS_OPENROUTER = (process.env.OPENAI_API_BASE_URL || '').includes('openrouter');
// OpenRouter exige ID com provedor, ex: openai/text-embedding-3-small
const DEFAULT_MODEL = BASE_IS_OPENROUTER ? 'openai/text-embedding-3-small' : 'text-embedding-3-small';
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;
const MAX_TEXT_LEN = 8000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

if (!OPENAI_API_KEY) {
  console.error('Defina OPENAI_API_KEY no .env (ex.: chave da OpenAI para text-embedding-3-small).');
  process.exit(1);
}

const pool = new pg.Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  ssl: process.env.DB_SSLMODE === 'require' ? { rejectUnauthorized: false } : false,
});

async function getTablesWithEmbedding(client) {
  const r = await client.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'bluepoint' AND column_name = 'embedding'
    ORDER BY table_name
  `);
  return r.rows.map((x) => x.table_name);
}

async function getTablePk(client, table) {
  const r = await client.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = ('bluepoint.' || quote_ident($1))::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY array_position(i.indkey, a.attnum)
  `, [table]);
  return r.rows.map((x) => x.attname);
}

async function getTextColumns(client, table) {
  const r = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'bluepoint' AND table_name = $1
      AND column_name NOT IN ('embedding')
      AND data_type NOT IN ('bytea', 'USER-DEFINED')
    ORDER BY ordinal_position
  `, [table]);
  return r.rows.map((x) => x.column_name);
}

function rowToText(row, columns) {
  const parts = [];
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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function embedBatch(texts) {
  const url = `${OPENAI_API_BASE_URL}/embeddings`;
  const payload = { input: texts, model: EMBEDDING_MODEL };
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      const data = body ? JSON.parse(body) : {};
      if (!res.ok) {
        const errMsg = data?.error?.message || body || res.statusText;
        throw new Error(`API embeddings: ${res.status} ${errMsg}`);
      }
      const list = data?.data ?? data?.embeddings ?? data;
      if (!Array.isArray(list)) {
        throw new Error(`Resposta inesperada da API (sem data/embeddings): ${JSON.stringify(data).slice(0, 200)}`);
      }
      return list.map((d) => (d.embedding ?? d));
    } catch (err) {
      lastError = err;
      const msg = (err && err.message) ? String(err.message) : '';
      const isRetryable = /404|429|50\d|ECONNREFUSED|fetch|network/i.test(msg);
      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`    [retry ${attempt}/${MAX_RETRIES}] em ${delay}ms: ${msg.slice(0, 80)}`);
        await sleep(delay);
      } else {
        throw lastError;
      }
    }
  }
  throw lastError;
}

async function processTable(client, table) {
  const allCols = await getTextColumns(client, table);
  if (allCols.length === 0) {
    console.log(`  [${table}] sem colunas de texto, pulando`);
    return { table, updated: 0 };
  }

  const pkCols = await getTablePk(client, table);
  const idCol = pkCols[0] || allCols[0] || 'id';
  const colsForSelect = [idCol, ...allCols.filter((c) => c !== idCol)];
  const colList = colsForSelect.map((c) => `"${c}"`).join(', ');
  let offset = 0;
  let totalUpdated = 0;

  while (true) {
    const rows = await client.query(
      `SELECT ${colList} FROM bluepoint."${table}" WHERE embedding IS NULL ORDER BY "${idCol}" LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );
    if (rows.rows.length === 0) break;

    const texts = rows.rows.map((row) => rowToText(row, colsForSelect));
    const embeddings = await embedBatch(texts);

    for (let i = 0; i < rows.rows.length; i++) {
      const id = rows.rows[i][idCol];
      const vec = embeddings[i];
      const vecStr = `[${vec.join(',')}]`;
      await client.query(
        `UPDATE bluepoint."${table}" SET embedding = $1::vector WHERE "${idCol}" = $2`,
        [vecStr, id]
      );
      totalUpdated++;
    }

    offset += BATCH_SIZE;
    process.stdout.write(`  [${table}] ${totalUpdated} linhas\r`);
  }

  return { table, updated: totalUpdated };
}

async function main() {
  console.log('Conectando ao banco...');
  const client = await pool.connect();
  try {
    await client.query("SET search_path TO bluepoint, public");
    const tables = await getTablesWithEmbedding(client);
    console.log(`Tabelas com coluna embedding: ${tables.length}\n`);

    const results = [];
    for (const table of tables) {
      try {
        const r = await processTable(client, table);
        results.push(r);
        console.log(`  [${table}] ${r.updated} linhas atualizadas`);
      } catch (err) {
        console.error(`  [${table}] ERRO:`, err.message);
        results.push({ table, updated: 0, error: err.message });
      }
    }

    const total = results.reduce((s, r) => s + (r.updated || 0), 0);
    console.log(`\nConcluído. Total de embeddings gravados: ${total}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
