import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

types.setTypeParser(1114, (val: string) => val);
types.setTypeParser(1184, (val: string) => val);
types.setTypeParser(1082, (val: string) => val);

const isProduction = process.env.NODE_ENV === 'production';

// =====================================================
// Configuração dos bancos
// =====================================================
const primaryConfig = {
  host: process.env.DB_HOST!,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_DATABASE!,
  user: process.env.DB_USERNAME!,
};

const fallbackConfig = {
  host: process.env.DB_FALLBACK_HOST || '172.17.0.1',
  port: parseInt(process.env.DB_FALLBACK_PORT || '5437'),
  database: process.env.DB_FALLBACK_DATABASE || 'bluepoint_vector',
  user: process.env.DB_FALLBACK_USERNAME || 'bluepoint',
  password: process.env.DB_FALLBACK_PASSWORD || 'Bluetech*9090',
};

// =====================================================
// Criação dos pools
// =====================================================
async function createPrimaryPool(): Promise<Pool> {
  let password = process.env.DB_PASSWORD;

  if (isProduction && process.env.DB_USE_IAM_AUTH === 'true') {
    const signer = new Signer({
      hostname: primaryConfig.host,
      port: primaryConfig.port,
      username: primaryConfig.user,
      region: process.env.AWS_REGION || 'us-east-1',
    });
    password = await signer.getAuthToken();
  }

  const pool = new Pool({
    ...primaryConfig,
    password,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: 20,
    min: 0,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: false,
    options: `-c search_path=people,public -c timezone=America/Sao_Paulo`,
  });

  pool.on('error', (err) => {
    console.error('[DB] Pool primário — erro de conexão em background:', err.message);
  });

  return pool;
}

function createFallbackPool(): Pool {
  const pool = new Pool({
    ...fallbackConfig,
    ssl: false,
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: false,
    options: `-c search_path=people,public -c timezone=America/Sao_Paulo`,
  });

  pool.on('error', (err) => {
    console.error('[DB] Pool fallback — erro de conexão em background:', err.message);
  });

  return pool;
}

// =====================================================
// Gerenciamento dos pools com renovação IAM
// =====================================================
let primaryPool: Pool | null = null;
let fallbackPool: Pool | null = null;
let primaryCreatedAt = 0;
let usingFallback = false;
let primaryFailedAt = 0;
const PRIMARY_RETRY_INTERVAL = 60 * 1000; // tenta reconectar ao primário a cada 60s

async function getPrimaryPool(): Promise<Pool> {
  const now = Date.now();
  const age = now - primaryCreatedAt;
  if (!primaryPool || (isProduction && age > 14 * 60 * 1000)) {
    if (primaryPool) await primaryPool.end().catch(() => {});
    primaryPool = await createPrimaryPool();
    primaryCreatedAt = now;
  }
  return primaryPool;
}

function getFallbackPool(): Pool {
  if (!fallbackPool) {
    fallbackPool = createFallbackPool();
  }
  return fallbackPool;
}

// =====================================================
// Obtém pool ativo — tenta primary, cai no fallback
// =====================================================
async function getActivePool(): Promise<{ pool: Pool; isFallback: boolean }> {
  const now = Date.now();
  const primaryCoolingDown = usingFallback && (now - primaryFailedAt) < PRIMARY_RETRY_INTERVAL;

  if (!primaryCoolingDown) {
    try {
      const pool = await getPrimaryPool();
      await pool.query('SELECT 1'); // testa conexão
      if (usingFallback) {
        console.warn('[DB] Reconectado ao banco primário (AWS Aurora)');
        usingFallback = false;
        primaryFailedAt = 0;
      }
      return { pool, isFallback: false };
    } catch (err) {
      if (!usingFallback) {
        console.warn('[DB] Banco primário indisponível, usando fallback local:', (err as Error).message);
        usingFallback = true;
      }
      primaryFailedAt = now;
      primaryPool = null; // força recriação na próxima tentativa
    }
  }

  return { pool: getFallbackPool(), isFallback: true };
}

// =====================================================
// API pública
// =====================================================
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const { pool } = await getActivePool();
  const result = await pool.query<T>(text, params);
  return result;
}

export async function getClient(): Promise<PoolClient> {
  const { pool } = await getActivePool();
  const client = await pool.connect();
  await client.query("SET search_path TO people, public; SET timezone TO 'America/Sao_Paulo'");
  return client;
}

export async function healthCheck(): Promise<{ healthy: boolean; source: string }> {
  try {
    const { pool, isFallback } = await getActivePool();
    await pool.query('SELECT 1');
    return { healthy: true, source: isFallback ? 'fallback' : 'primary' };
  } catch {
    return { healthy: false, source: 'none' };
  }
}

export function getPoolStats() {
  return {
    primary: primaryPool ? {
      total: primaryPool.totalCount,
      idle: primaryPool.idleCount,
      waiting: primaryPool.waitingCount,
    } : null,
    fallback: fallbackPool ? {
      total: fallbackPool.totalCount,
      idle: fallbackPool.idleCount,
      waiting: fallbackPool.waitingCount,
    } : null,
    recrutamento: recrutamentoPool ? {
      total: recrutamentoPool.totalCount,
      idle: recrutamentoPool.idleCount,
      waiting: recrutamentoPool.waitingCount,
    } : null,
    usingFallback,
  };
}

// =====================================================
// Pool secundário read-only — banco de Recrutamento
// (tabela public.candidatos em DigitalOcean)
// =====================================================
let recrutamentoPool: Pool | null = null;

function createRecrutamentoPool(): Pool {
  const url = process.env.DATABASE_URL_RECRUTAMENTO;
  if (!url) {
    throw new Error('DATABASE_URL_RECRUTAMENTO não configurada');
  }

  // Parsear manualmente em vez de usar `connectionString`. Versões recentes
  // do pg-connection-string passaram a tratar `sslmode=require` como
  // `verify-full`, o que sobrescreve o objeto `ssl` passado adiante e
  // causa SELF_SIGNED_CERT_IN_CHAIN ao falar com o Postgres do DigitalOcean
  // (cert não está na cadeia padrão do Node).
  const parsed = new URL(url);

  const pool = new Pool({
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'defaultdb',
    ssl: { rejectUnauthorized: false },
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: false,
  });

  pool.on('error', (err) => {
    console.error('[DB] Pool recrutamento — erro de conexão em background:', err.message);
  });

  return pool;
}

function getRecrutamentoPool(): Pool {
  if (!recrutamentoPool) {
    recrutamentoPool = createRecrutamentoPool();
  }
  return recrutamentoPool;
}

// Defesa em profundidade: o usuário do pool já é "doadmin" (full),
// então rejeitamos qualquer query que não seja SELECT/WITH no nível da app.
const READONLY_PREFIX = /^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(SELECT|WITH)\b/i;

export async function queryRecrutamento<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  if (!READONLY_PREFIX.test(text)) {
    throw new Error('queryRecrutamento aceita apenas SELECT/WITH (read-only)');
  }
  const pool = getRecrutamentoPool();
  return pool.query<T>(text, params);
}

export type { PoolClient };
export default { query, getClient, healthCheck, getPoolStats };