import Redis from 'ioredis';

// Configuração do Redis
const REDIS_HOST = process.env.REDIS_HOST || 'portal_do_empregado-redis-1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

// TTLs padrão (em segundos)
export const CACHE_TTL = {
  SHORT: 60,           // 1 minuto - dados que mudam frequentemente
  MEDIUM: 300,         // 5 minutos - dados moderadamente estáveis
  LONG: 3600,          // 1 hora - dados estáveis
  VERY_LONG: 86400,    // 24 horas - dados raramente alterados
};

// Prefixos de cache
export const CACHE_KEYS = {
  // Entidades principais
  COLABORADOR: 'colaborador:',
  COLABORADORES: 'colaboradores:',
  EMPRESA: 'empresa:',
  EMPRESAS: 'empresas:',
  JORNADA: 'jornada:',
  JORNADAS: 'jornadas:',
  CARGO: 'cargo:',
  CARGOS: 'cargos:',
  DEPARTAMENTO: 'departamento:',
  DEPARTAMENTOS: 'departamentos:',
  
  // Feriados e configurações
  FERIADO: 'feriado:',
  FERIADOS: 'feriados:',
  CONFIGURACOES: 'configuracoes:',
  TOLERANCIAS: 'tolerancias:',
  
  // Marcações e ponto
  MARCACAO: 'marcacao:',
  MARCACOES: 'marcacoes:',
  MARCACOES_HOJE: 'marcacoes_hoje:',
  BANCO_HORAS: 'banco_horas:',
  SALDO_HORAS: 'saldo_horas:',
  HISTORICO_HORAS: 'historico_horas:',
  
  // Solicitações
  SOLICITACAO: 'solicitacao:',
  SOLICITACOES: 'solicitacoes:',
  TIPOS_SOLICITACAO: 'tipos_solicitacao:',
  
  // Tolerância de atraso
  ATRASOS_TOLERADOS: 'atrasos_tolerados:',
  PARAMETROS_TOLERANCIA_ATRASO: 'parametros_tolerancia_atraso:',

  // Horas extras
  HORAS_EXTRAS: 'horas_extras:',
  PARAMETROS_HORA_EXTRA: 'parametros_hora_extra:',
  PARAMETROS_BENEFICIOS: 'parametros_beneficios:',
  TOLERANCIA_HORA_EXTRA: 'tolerancia_hora_extra:',
  SOLICITACOES_HORAS_EXTRAS: 'solicitacoes_horas_extras:',
  CUSTO_HORAS_EXTRAS: 'custo_horas_extras:',
  LIMITES_HE_GESTORES: 'limites_he_gestores:',
  LIMITES_HE_EMPRESAS: 'limites_he_empresas:',
  LIMITES_HE_DEPARTAMENTOS: 'limites_he_departamentos:',
  LIDERANCAS_DEPARTAMENTO: 'liderancas_departamento:',
  HORAS_EXTRAS_CONSOLIDADO: 'horas_extras_consolidado:',
  
  // Dispositivos
  DISPOSITIVO: 'dispositivo:',
  DISPOSITIVOS: 'dispositivos:',
  
  // Biometria
  BIOMETRIA: 'biometria:',
  BIOMETRIA_ENCODINGS: 'biometria:encodings',
  BIOMETRIA_STATUS: 'biometria:status:',
  
  // Notificações
  NOTIFICACAO: 'notificacao:',
  NOTIFICACOES: 'notificacoes:',
  
  // Localizações e geofence
  LOCALIZACAO: 'localizacao:',
  LOCALIZACOES: 'localizacoes:',
  
  // Documentos e anexos
  DOCUMENTO: 'documento:',
  DOCUMENTOS: 'documentos:',
  ANEXO: 'anexo:',
  ANEXOS: 'anexos:',
  
  // API Keys
  API_KEY: 'api_key:',
  API_KEYS: 'api_keys:',
  
  // Exportação
  MODELOS_EXPORTACAO: 'modelos_exportacao:',
  MODELO_EXPORTACAO: 'modelo_exportacao:',
  
  // Logs e auditoria
  LOGS_AUDITORIA: 'logs_auditoria:',
  
  // Resumos e visão geral
  VISAO_GERAL: 'visao_geral:',
  RESUMO_COLABORADOR: 'resumo_colaborador:',
  STATUS_TEMPO_REAL: 'status_tempo_real:',
  
  // Permissões
  PERMISSOES: 'permissoes:',
  PAPEL_PERMISSOES: 'papel_permissoes:',
  
  // Alertas Inteligentes (IA)
  ALERTAS_INTELIGENTES: 'alertas_inteligentes:',

  // Rate limiting
  RATE_LIMIT: 'rate_limit:',
};

// Cliente Redis singleton
let redis: Redis | null = null;
let connectionAttempted = false;

/**
 * Obtém a instância do Redis (lazy loading)
 */
export function getRedis(): Redis | null {
  if (redis) return redis;
  
  if (connectionAttempted) return null;
  connectionAttempted = true;

  try {
    const options: {
      host: string;
      port: number;
      password?: string;
      maxRetriesPerRequest: number;
      lazyConnect: boolean;
      connectTimeout: number;
      retryStrategy: (times: number) => number | null;
    } = {
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      connectTimeout: 5000,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.warn('Redis: Máximo de tentativas de reconexão atingido');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    };

    if (REDIS_PASSWORD) {
      options.password = REDIS_PASSWORD;
    }

    redis = new Redis(options);

    redis.on('connect', () => {
      console.log('Redis conectado');
    });

    redis.on('error', (err: Error) => {
      console.warn('Redis erro:', err.message);
    });

    redis.on('close', () => {
      console.log('Redis desconectado');
    });

    // Conectar
    redis.connect().catch((err: Error) => {
      console.warn('Redis: Falha ao conectar -', err.message);
      redis = null;
    });

    return redis;
  } catch (error) {
    console.warn('Redis: Erro ao criar cliente -', error);
    return null;
  }
}

/**
 * Obtém valor do cache
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const data = await client.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch (error) {
    console.warn('Cache get error:', error);
    return null;
  }
}

/**
 * Define valor no cache
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = CACHE_TTL.MEDIUM): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('Cache set error:', error);
    return false;
  }
}

/**
 * Remove valor do cache
 */
export async function cacheDel(key: string): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    await client.del(key);
    return true;
  } catch (error) {
    console.warn('Cache del error:', error);
    return false;
  }
}

/**
 * Remove valores por padrão (ex: "colaboradores:*")
 */
export async function cacheDelPattern(pattern: string): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    return true;
  } catch (error) {
    console.warn('Cache del pattern error:', error);
    return false;
  }
}

/**
 * Invalida cache de uma entidade específica e suas listas
 */
export async function invalidateCache(prefix: string, id?: number | string): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    // Invalida item específico se ID fornecido
    if (id !== undefined) {
      await cacheDel(`${prefix}${id}`);
    }
    
    // Invalida listas relacionadas
    await cacheDelPattern(`${prefix}list:*`);
  } catch (error) {
    console.warn('Invalidate cache error:', error);
  }
}

/**
 * Wrapper para cache-aside pattern
 * Tenta obter do cache, se não existir executa a função e cacheia o resultado
 */
export async function cacheAside<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number = CACHE_TTL.MEDIUM
): Promise<T> {
  // Tentar obter do cache
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Executar função e cachear
  const result = await fetchFn();
  await cacheSet(key, result, ttlSeconds);
  return result;
}

/**
 * Verifica se o Redis está conectado
 */
export async function isRedisConnected(): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Estatísticas do cache
 */
export async function getCacheStats(): Promise<{
  connected: boolean;
  keys?: number;
  memory?: string;
}> {
  const connected = await isRedisConnected();
  if (!connected) return { connected: false };

  const client = getRedis()!;
  try {
    const info = await client.info('memory');
    const dbSize = await client.dbsize();
    
    const memoryMatch = info.match(/used_memory_human:(\S+)/);
    
    return {
      connected: true,
      keys: dbSize,
      memory: memoryMatch ? memoryMatch[1] : 'N/A',
    };
  } catch {
    return { connected: true };
  }
}

/**
 * Rate limiting por IP
 * Retorna true se a requisição está dentro do limite
 */
export async function checkRateLimit(
  identifier: string,
  maxRequests: number = 30,
  windowSeconds: number = 60
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const client = getRedis();
  
  // Se Redis não está disponível, permite todas (fail-open)
  if (!client) {
    return { allowed: true, remaining: maxRequests, resetIn: 0 };
  }

  const key = `${CACHE_KEYS.RATE_LIMIT}${identifier}`;
  
  try {
    const current = await client.incr(key);
    
    if (current === 1) {
      // Primeira requisição, define TTL
      await client.expire(key, windowSeconds);
    }

    const ttl = await client.ttl(key);
    const remaining = Math.max(0, maxRequests - current);
    
    return {
      allowed: current <= maxRequests,
      remaining,
      resetIn: ttl > 0 ? ttl : windowSeconds,
    };
  } catch (error) {
    console.warn('Rate limit check error:', error);
    return { allowed: true, remaining: maxRequests, resetIn: 0 };
  }
}

/**
 * Cache binário (para encodings faciais)
 */
export async function cacheGetBuffer(key: string): Promise<Buffer | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const data = await client.getBuffer(key);
    return data;
  } catch (error) {
    console.warn('Cache get buffer error:', error);
    return null;
  }
}

export async function cacheSetBuffer(key: string, value: Buffer, ttlSeconds: number): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    await client.setex(key, ttlSeconds, value);
    return true;
  } catch (error) {
    console.warn('Cache set buffer error:', error);
    return false;
  }
}

/**
 * Gera chave de cache para listagens paginadas com filtros
 */
export function buildListCacheKey(prefix: string, params: Record<string, unknown>): string {
  // Ordena as chaves para garantir consistência
  const sortedParams = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}:${params[k]}`)
    .join('|');
  
  return `${prefix}list:${sortedParams || 'all'}`;
}

/**
 * Invalida múltiplos prefixos de cache de uma vez
 */
export async function invalidateMultipleCache(prefixes: string[]): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    await Promise.all(prefixes.map(prefix => cacheDelPattern(`${prefix}*`)));
  } catch (error) {
    console.warn('Invalidate multiple cache error:', error);
  }
}

/**
 * Invalida cache relacionado a colaboradores (usado em criação/atualização/exclusão)
 */
export async function invalidateColaboradorCache(colaboradorId?: number | string): Promise<void> {
  await invalidateMultipleCache([
    CACHE_KEYS.COLABORADORES,
    CACHE_KEYS.MARCACOES,
    CACHE_KEYS.MARCACOES_HOJE,
    CACHE_KEYS.VISAO_GERAL,
    CACHE_KEYS.STATUS_TEMPO_REAL,
  ]);
  
  if (colaboradorId) {
    await cacheDel(`${CACHE_KEYS.COLABORADOR}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.RESUMO_COLABORADOR}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.BANCO_HORAS}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.SALDO_HORAS}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.BIOMETRIA_STATUS}${colaboradorId}`);
  }
}

/**
 * Invalida cache relacionado a empresas
 */
export async function invalidateEmpresaCache(empresaId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.EMPRESAS}*`);
  await cacheDelPattern(`${CACHE_KEYS.VISAO_GERAL}*`);
  
  if (empresaId) {
    await cacheDel(`${CACHE_KEYS.EMPRESA}${empresaId}`);
  }
}

/**
 * Invalida cache relacionado a departamentos
 */
export async function invalidateDepartamentoCache(departamentoId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.DEPARTAMENTOS}*`);
  await cacheDelPattern(`${CACHE_KEYS.COLABORADORES}*`);
  
  if (departamentoId) {
    await cacheDel(`${CACHE_KEYS.DEPARTAMENTO}${departamentoId}`);
  }
}

/**
 * Invalida cache relacionado a jornadas
 */
export async function invalidateJornadaCache(jornadaId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.JORNADAS}*`);
  await cacheDelPattern(`${CACHE_KEYS.COLABORADORES}*`);
  
  if (jornadaId) {
    await cacheDel(`${CACHE_KEYS.JORNADA}${jornadaId}`);
  }
}

/**
 * Invalida cache relacionado a cargos
 */
export async function invalidateCargoCache(cargoId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.CARGOS}*`);
  
  if (cargoId) {
    await cacheDel(`${CACHE_KEYS.CARGO}${cargoId}`);
  }
}

/**
 * Invalida cache relacionado a marcações (usado em registrar entrada/saída, criar/atualizar marcação)
 */
export async function invalidateMarcacaoCache(colaboradorId?: number | string): Promise<void> {
  await invalidateMultipleCache([
    CACHE_KEYS.MARCACOES,
    CACHE_KEYS.MARCACOES_HOJE,
    CACHE_KEYS.VISAO_GERAL,
    CACHE_KEYS.STATUS_TEMPO_REAL,
  ]);
  
  if (colaboradorId) {
    await cacheDel(`${CACHE_KEYS.BANCO_HORAS}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.SALDO_HORAS}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.HISTORICO_HORAS}${colaboradorId}`);
    await cacheDel(`${CACHE_KEYS.RESUMO_COLABORADOR}${colaboradorId}`);
  }
}

/**
 * Invalida cache relacionado a solicitações
 */
export async function invalidateSolicitacaoCache(solicitacaoId?: number | string, colaboradorId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.SOLICITACOES}*`);
  
  if (solicitacaoId) {
    await cacheDel(`${CACHE_KEYS.SOLICITACAO}${solicitacaoId}`);
  }
  
  if (colaboradorId) {
    await cacheDel(`${CACHE_KEYS.RESUMO_COLABORADOR}${colaboradorId}`);
  }
}

/**
 * Invalida cache relacionado a dispositivos
 */
export async function invalidateDispositivoCache(dispositivoId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.DISPOSITIVOS}*`);
  
  if (dispositivoId) {
    await cacheDel(`${CACHE_KEYS.DISPOSITIVO}${dispositivoId}`);
  }
}

/**
 * Invalida cache relacionado a feriados
 */
export async function invalidateFeriadoCache(feriadoId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.FERIADOS}*`);
  
  if (feriadoId) {
    await cacheDel(`${CACHE_KEYS.FERIADO}${feriadoId}`);
  }
}

/**
 * Invalida cache relacionado a notificações
 */
export async function invalidateNotificacaoCache(notificacaoId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.NOTIFICACOES}*`);
  
  if (notificacaoId) {
    await cacheDel(`${CACHE_KEYS.NOTIFICACAO}${notificacaoId}`);
  }
}

/**
 * Invalida cache relacionado a localizações
 */
export async function invalidateLocalizacaoCache(localizacaoId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.LOCALIZACOES}*`);
  
  if (localizacaoId) {
    await cacheDel(`${CACHE_KEYS.LOCALIZACAO}${localizacaoId}`);
  }
}

/**
 * Invalida cache relacionado a solicitações de horas extras (módulo de custos)
 */
export async function invalidateSolicitacoesHorasExtrasCache(solicitacaoId?: number | string): Promise<void> {
  await invalidateMultipleCache([
    CACHE_KEYS.SOLICITACOES_HORAS_EXTRAS,
    CACHE_KEYS.CUSTO_HORAS_EXTRAS,
    CACHE_KEYS.HORAS_EXTRAS_CONSOLIDADO,
  ]);

  if (solicitacaoId) {
    await cacheDel(`${CACHE_KEYS.CUSTO_HORAS_EXTRAS}${solicitacaoId}`);
  }
}

/**
 * Invalida cache relacionado a limites de HE por gestor
 */
export async function invalidateLimitesHeGestoresCache(): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.LIMITES_HE_GESTORES}*`);
}

export async function invalidateLimitesHeEmpresasCache(): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.LIMITES_HE_EMPRESAS}*`);
}

export async function invalidateLimitesHeDepartamentosCache(): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.LIMITES_HE_DEPARTAMENTOS}*`);
}

export async function invalidateLiderancasDepartamentoCache(): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.LIDERANCAS_DEPARTAMENTO}*`);
}

/**
 * Invalida cache relacionado a parâmetros de hora extra
 */
export async function invalidateParametrosHoraExtraCache(): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.PARAMETROS_HORA_EXTRA}*`);
  await cacheDelPattern(`${CACHE_KEYS.TOLERANCIA_HORA_EXTRA}*`);
  // Também invalida marcações e acompanhamento pois dependem dos parâmetros
  await cacheDelPattern(`${CACHE_KEYS.MARCACOES}*`);
}

export async function invalidateParametrosBeneficiosCache(): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.PARAMETROS_BENEFICIOS}*`);
}

/**
 * Invalida cache relacionado a tolerância de hora extra de um colaborador
 */
export async function invalidateToleranciaHoraExtraCache(colaboradorId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.TOLERANCIA_HORA_EXTRA}*`);
  
  if (colaboradorId) {
    await cacheDel(`${CACHE_KEYS.TOLERANCIA_HORA_EXTRA}${colaboradorId}`);
  }
}

/**
 * Invalida cache relacionado a API Keys
 */
export async function invalidateApiKeyCache(apiKeyId?: number | string): Promise<void> {
  await cacheDelPattern(`${CACHE_KEYS.API_KEYS}*`);
  
  if (apiKeyId) {
    await cacheDel(`${CACHE_KEYS.API_KEY}${apiKeyId}`);
  }
}

/**
 * Invalida todo o cache (usar com cuidado!)
 */
export async function invalidateAllCache(): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    await client.flushdb();
    console.log('Cache completamente limpo');
  } catch (error) {
    console.warn('Flush cache error:', error);
  }
}
