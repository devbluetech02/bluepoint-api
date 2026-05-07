declare module 'oracledb' {
  export const OUT_FORMAT_OBJECT: number;
  export const OUT_FORMAT_ARRAY: number;

  export interface InitOracleClientOptions {
    libDir?: string;
    configDir?: string;
    errorUrl?: string;
  }
  export function initOracleClient(options?: InitOracleClientOptions): void;

  export interface PoolAttributes {
    user?: string;
    password?: string;
    connectString?: string;
    poolMin?: number;
    poolMax?: number;
    poolIncrement?: number;
    poolTimeout?: number;
    queueTimeout?: number;
  }
  export interface ExecuteOptions {
    outFormat?: number;
    autoCommit?: boolean;
    bindDefs?: unknown;
    fetchInfo?: unknown;
  }
  export interface Result<T = unknown> {
    rows?: T[];
    rowsAffected?: number;
    metaData?: Array<{ name: string }>;
    outBinds?: Record<string, unknown>;
  }
  export interface Connection {
    execute<T = unknown>(
      sql: string,
      bindParams?: Record<string, unknown> | unknown[],
      options?: ExecuteOptions,
    ): Promise<Result<T>>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
  }
  export interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }
  export function createPool(attrs: PoolAttributes): Promise<Pool>;
  export function getConnection(attrs: PoolAttributes): Promise<Connection>;

  const _default: {
    OUT_FORMAT_OBJECT: number;
    OUT_FORMAT_ARRAY: number;
    initOracleClient: typeof initOracleClient;
    createPool: typeof createPool;
    getConnection: typeof getConnection;
  };
  export default _default;
}
