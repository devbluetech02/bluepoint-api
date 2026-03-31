import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';

// =====================================================
// Impedir que o driver pg converta timestamps para Date JS (que sempre usa UTC).
// Retorna os valores como string direto do banco, sem conversão de fuso horário.
// Isso evita que 12:01 (Brasil) vire 15:01Z no JSON da resposta.
// =====================================================
// TIMESTAMP WITHOUT TIME ZONE (OID 1114)
types.setTypeParser(1114, (val: string) => val);
// TIMESTAMP WITH TIME ZONE (OID 1184)
types.setTypeParser(1184, (val: string) => val);
// DATE (OID 1082)
types.setTypeParser(1082, (val: string) => val);

// Configurações otimizadas do pool para uso com PgBouncer
const pool = new Pool({
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_DATABASE,
  ssl: process.env.DB_SSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  
  // Pool settings otimizados para PgBouncer
  max: 20,                    // Máximo de conexões no pool
  min: 2,                     // Mínimo de conexões mantidas
  idleTimeoutMillis: 30000,   // Tempo máximo de conexão ociosa (30s)
  connectionTimeoutMillis: 5000, // Timeout para obter conexão (5s)
  
  // Importante para PgBouncer em modo transaction
  allowExitOnIdle: true,
});

// Definir search_path e timezone para cada conexão
pool.on('connect', (client) => {
  client.query("SET search_path TO people, public; SET timezone TO 'America/Sao_Paulo'");
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  
  if (process.env.NODE_ENV === 'development') {
    console.log('Query executada:', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }
  
  return result;
}

export async function getClient(): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query("SET search_path TO people, public; SET timezone TO 'America/Sao_Paulo'");
  return client;
}

/**
 * Estatísticas do pool de conexões
 */
export function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

/**
 * Verifica saúde da conexão
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1');
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

export type { PoolClient };
export default pool;
