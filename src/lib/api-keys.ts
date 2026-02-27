import { query } from './db';
import { cacheGet, cacheSet, cacheDel, checkRateLimit } from './cache';
import crypto from 'crypto';

// =====================================================
// TIPOS
// =====================================================

export interface ApiKey {
  id: number;
  nome: string;
  descricao: string | null;
  token: string;
  permissoes: string[];
  modulosPermitidos: string[];
  rateLimitPorMinuto: number;
  rateLimitPorDia: number;
  ipsPermitidos: string[];
  empresaId: number | null;
  status: 'ativo' | 'inativo' | 'revogado';
  ultimoUso: Date | null;
  totalRequisicoes: number;
  criadoEm: Date;
  expiraEm: Date | null;
}

export interface ApiKeyValidation {
  valida: boolean;
  apiKey?: ApiKey;
  erro?: string;
  code?: string;
}

// =====================================================
// CONSTANTES
// =====================================================

const DEFAULT_PREFIX = 'bp_api_';
const API_KEY_CACHE_TTL = 300; // 5 minutos
const API_KEY_CACHE_PREFIX = 'api_key:';

// =====================================================
// FUNÇÕES DE GERAÇÃO
// =====================================================

/**
 * Normaliza prefixo para formato seguro (lowercase, underscores)
 */
export function normalizarPrefixo(prefixo: string): string {
  return prefixo
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '_')  // Substitui caracteres especiais por _
    .replace(/_+/g, '_')          // Remove underscores duplicados
    .replace(/^_|_$/g, '');       // Remove underscores no início/fim
}

/**
 * Gera um novo token de API com prefixo customizado
 * @param prefixo - Prefixo personalizado (ex: "app_vendedores")
 */
export function gerarApiToken(prefixo?: string): string {
  const randomBytes = crypto.randomBytes(16).toString('hex'); // 32 caracteres hex
  
  if (prefixo) {
    const prefixoNormalizado = normalizarPrefixo(prefixo);
    return `${prefixoNormalizado}_${randomBytes}`;
  }
  
  return `${DEFAULT_PREFIX}${randomBytes}`;
}

/**
 * Gera hash do token para armazenamento seguro (opcional)
 */
export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// =====================================================
// VALIDAÇÃO
// =====================================================

/**
 * Valida um token de API
 */
export async function validarApiKey(
  token: string,
  ip?: string,
  modulo?: string
): Promise<ApiKeyValidation> {
  // Verificar formato básico do token (prefixo_hash)
  // Tokens devem ter pelo menos: prefixo (3+) + underscore + hash (32) = 36 caracteres
  if (!token || token.length < 36 || !token.includes('_')) {
    return { valida: false, erro: 'Formato de token inválido', code: 'INVALID_FORMAT' };
  }

  // Tentar buscar do cache primeiro
  const cacheKey = `${API_KEY_CACHE_PREFIX}${token}`;
  let apiKey = await cacheGet<ApiKey>(cacheKey);

  // Se não está no cache, buscar do banco
  if (!apiKey) {
    const result = await query(
      `SELECT 
        id, nome, descricao, token, 
        permissoes, modulos_permitidos as "modulosPermitidos",
        rate_limit_por_minuto as "rateLimitPorMinuto",
        rate_limit_por_dia as "rateLimitPorDia",
        ips_permitidos as "ipsPermitidos",
        empresa_id as "empresaId",
        status, ultimo_uso as "ultimoUso",
        total_requisicoes as "totalRequisicoes",
        criado_em as "criadoEm", expira_em as "expiraEm"
      FROM bluepoint.bt_api_keys
      WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return { valida: false, erro: 'Token de API inválido', code: 'INVALID_TOKEN' };
    }

    apiKey = result.rows[0] as ApiKey;

    // Cachear para próximas requisições
    await cacheSet(cacheKey, apiKey, API_KEY_CACHE_TTL);
  }

  // Verificar status
  if (apiKey.status !== 'ativo') {
    return { 
      valida: false, 
      erro: `Token ${apiKey.status}`, 
      code: apiKey.status === 'revogado' ? 'TOKEN_REVOKED' : 'TOKEN_INACTIVE' 
    };
  }

  // Verificar expiração
  if (apiKey.expiraEm && new Date(apiKey.expiraEm) < new Date()) {
    return { valida: false, erro: 'Token expirado', code: 'TOKEN_EXPIRED' };
  }

  // Verificar IP (se configurado)
  if (ip && apiKey.ipsPermitidos && apiKey.ipsPermitidos.length > 0) {
    const ipPermitido = apiKey.ipsPermitidos.some(permitido => {
      // Suporte a CIDR básico ou IP exato
      if (permitido.includes('/')) {
        // CIDR - simplificado, apenas verifica prefixo
        const [rede] = permitido.split('/');
        return ip.startsWith(rede.split('.').slice(0, 3).join('.'));
      }
      return ip === permitido;
    });

    if (!ipPermitido) {
      return { valida: false, erro: 'IP não autorizado', code: 'IP_NOT_ALLOWED' };
    }
  }

  // Verificar módulo (se especificado)
  if (modulo && apiKey.modulosPermitidos) {
    const moduloPermitido = 
      apiKey.modulosPermitidos.includes('*') || 
      apiKey.modulosPermitidos.includes(modulo);

    if (!moduloPermitido) {
      return { valida: false, erro: 'Módulo não autorizado para este token', code: 'MODULE_NOT_ALLOWED' };
    }
  }

  // Verificar rate limit por minuto
  if (apiKey.rateLimitPorMinuto > 0) {
    const rateLimit = await checkRateLimit(
      `api_key:${apiKey.id}:min`,
      apiKey.rateLimitPorMinuto,
      60
    );

    if (!rateLimit.allowed) {
      return { 
        valida: false, 
        erro: 'Limite de requisições por minuto excedido', 
        code: 'RATE_LIMIT_MINUTE' 
      };
    }
  }

  // Verificar rate limit por dia
  if (apiKey.rateLimitPorDia > 0) {
    const rateLimit = await checkRateLimit(
      `api_key:${apiKey.id}:day`,
      apiKey.rateLimitPorDia,
      86400 // 24 horas
    );

    if (!rateLimit.allowed) {
      return { 
        valida: false, 
        erro: 'Limite de requisições diárias excedido', 
        code: 'RATE_LIMIT_DAY' 
      };
    }
  }

  return { valida: true, apiKey };
}

// =====================================================
// CRUD
// =====================================================

/**
 * Cria uma nova API Key
 */
export async function criarApiKey(dados: {
  nome: string;
  descricao?: string;
  prefixo?: string;  // Prefixo customizado (ex: "app_vendedores")
  permissoes?: string[];
  modulosPermitidos?: string[];
  rateLimitPorMinuto?: number;
  rateLimitPorDia?: number;
  ipsPermitidos?: string[];
  empresaId?: number;
  criadoPor?: number;
  expiraEm?: Date;
}): Promise<{ apiKey: ApiKey; token: string }> {
  const token = gerarApiToken(dados.prefixo);

  const result = await query(
    `INSERT INTO bluepoint.bt_api_keys (
      nome, descricao, token, permissoes, modulos_permitidos,
      rate_limit_por_minuto, rate_limit_por_dia, ips_permitidos,
      empresa_id, criado_por, expira_em
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING 
      id, nome, descricao, token, 
      permissoes, modulos_permitidos as "modulosPermitidos",
      rate_limit_por_minuto as "rateLimitPorMinuto",
      rate_limit_por_dia as "rateLimitPorDia",
      ips_permitidos as "ipsPermitidos",
      empresa_id as "empresaId",
      status, criado_em as "criadoEm", expira_em as "expiraEm"`,
    [
      dados.nome,
      dados.descricao || null,
      token,
      JSON.stringify(dados.permissoes || ['read']),
      JSON.stringify(dados.modulosPermitidos || ['*']),
      dados.rateLimitPorMinuto ?? 60,
      dados.rateLimitPorDia ?? 10000,
      JSON.stringify(dados.ipsPermitidos || []),
      dados.empresaId || null,
      dados.criadoPor || null,
      dados.expiraEm || null,
    ]
  );

  return {
    apiKey: result.rows[0] as ApiKey,
    token, // Retornar token apenas na criação!
  };
}

/**
 * Lista todas as API Keys
 */
export async function listarApiKeys(filtros?: {
  status?: string;
  empresaId?: number;
}): Promise<Omit<ApiKey, 'token'>[]> {
  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filtros?.status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(filtros.status);
    paramIndex++;
  }

  if (filtros?.empresaId) {
    whereClause += ` AND empresa_id = $${paramIndex}`;
    params.push(filtros.empresaId);
    paramIndex++;
  }

  const result = await query(
    `SELECT 
      id, nome, descricao,
      CONCAT(LEFT(token, 12), '...') as token, -- Mascarar token
      permissoes, modulos_permitidos as "modulosPermitidos",
      rate_limit_por_minuto as "rateLimitPorMinuto",
      rate_limit_por_dia as "rateLimitPorDia",
      ips_permitidos as "ipsPermitidos",
      empresa_id as "empresaId",
      status, ultimo_uso as "ultimoUso",
      total_requisicoes as "totalRequisicoes",
      criado_em as "criadoEm", expira_em as "expiraEm"
    FROM bluepoint.bt_api_keys
    ${whereClause}
    ORDER BY criado_em DESC`,
    params
  );

  return result.rows as Omit<ApiKey, 'token'>[];
}

/**
 * Obter API Key por ID (sem mostrar token completo)
 */
export async function obterApiKey(id: number): Promise<Omit<ApiKey, 'token'> | null> {
  const result = await query(
    `SELECT 
      id, nome, descricao,
      CONCAT(LEFT(token, 12), '...') as token,
      permissoes, modulos_permitidos as "modulosPermitidos",
      rate_limit_por_minuto as "rateLimitPorMinuto",
      rate_limit_por_dia as "rateLimitPorDia",
      ips_permitidos as "ipsPermitidos",
      empresa_id as "empresaId",
      status, ultimo_uso as "ultimoUso",
      total_requisicoes as "totalRequisicoes",
      criado_em as "criadoEm", expira_em as "expiraEm"
    FROM bluepoint.bt_api_keys
    WHERE id = $1`,
    [id]
  );

  return (result.rows[0] as Omit<ApiKey, 'token'>) || null;
}

/**
 * Atualiza uma API Key
 */
export async function atualizarApiKey(
  id: number,
  dados: Partial<{
    nome: string;
    descricao: string;
    permissoes: string[];
    modulosPermitidos: string[];
    rateLimitPorMinuto: number;
    rateLimitPorDia: number;
    ipsPermitidos: string[];
    status: string;
    expiraEm: Date | null;
  }>
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (dados.nome !== undefined) {
    sets.push(`nome = $${paramIndex}`);
    params.push(dados.nome);
    paramIndex++;
  }
  if (dados.descricao !== undefined) {
    sets.push(`descricao = $${paramIndex}`);
    params.push(dados.descricao);
    paramIndex++;
  }
  if (dados.permissoes !== undefined) {
    sets.push(`permissoes = $${paramIndex}`);
    params.push(JSON.stringify(dados.permissoes));
    paramIndex++;
  }
  if (dados.modulosPermitidos !== undefined) {
    sets.push(`modulos_permitidos = $${paramIndex}`);
    params.push(JSON.stringify(dados.modulosPermitidos));
    paramIndex++;
  }
  if (dados.rateLimitPorMinuto !== undefined) {
    sets.push(`rate_limit_por_minuto = $${paramIndex}`);
    params.push(dados.rateLimitPorMinuto);
    paramIndex++;
  }
  if (dados.rateLimitPorDia !== undefined) {
    sets.push(`rate_limit_por_dia = $${paramIndex}`);
    params.push(dados.rateLimitPorDia);
    paramIndex++;
  }
  if (dados.ipsPermitidos !== undefined) {
    sets.push(`ips_permitidos = $${paramIndex}`);
    params.push(JSON.stringify(dados.ipsPermitidos));
    paramIndex++;
  }
  if (dados.status !== undefined) {
    sets.push(`status = $${paramIndex}`);
    params.push(dados.status);
    paramIndex++;
  }
  if (dados.expiraEm !== undefined) {
    sets.push(`expira_em = $${paramIndex}`);
    params.push(dados.expiraEm);
    paramIndex++;
  }

  if (sets.length === 0) return false;

  sets.push('atualizado_em = NOW()');
  params.push(id);

  const result = await query(
    `UPDATE bluepoint.bt_api_keys SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
    params
  );

  // Invalidar cache
  const tokenResult = await query('SELECT token FROM bluepoint.bt_api_keys WHERE id = $1', [id]);
  if (tokenResult.rows[0]) {
    await cacheDel(`${API_KEY_CACHE_PREFIX}${tokenResult.rows[0].token}`);
  }

  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Revoga uma API Key
 */
export async function revogarApiKey(id: number): Promise<boolean> {
  const result = await query(
    `UPDATE bluepoint.bt_api_keys 
     SET status = 'revogado', revogado_em = NOW(), atualizado_em = NOW()
     WHERE id = $1`,
    [id]
  );

  // Invalidar cache
  const tokenResult = await query('SELECT token FROM bluepoint.bt_api_keys WHERE id = $1', [id]);
  if (tokenResult.rows[0]) {
    await cacheDel(`${API_KEY_CACHE_PREFIX}${tokenResult.rows[0].token}`);
  }

  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Regenera o token de uma API Key
 */
export async function regenerarApiToken(id: number): Promise<string | null> {
  // Invalidar cache do token antigo
  const oldTokenResult = await query('SELECT token FROM bluepoint.bt_api_keys WHERE id = $1', [id]);
  if (oldTokenResult.rows[0]) {
    await cacheDel(`${API_KEY_CACHE_PREFIX}${oldTokenResult.rows[0].token}`);
  }

  const novoToken = gerarApiToken();

  const result = await query(
    `UPDATE bluepoint.bt_api_keys 
     SET token = $1, atualizado_em = NOW()
     WHERE id = $2 AND status = 'ativo'
     RETURNING id`,
    [novoToken, id]
  );

  if (result.rows.length === 0) return null;

  return novoToken;
}

/**
 * Registra uso da API Key (atualiza contador e último uso)
 */
export async function registrarUsoApiKey(apiKeyId: number): Promise<void> {
  await query(
    `UPDATE bluepoint.bt_api_keys 
     SET ultimo_uso = NOW(), total_requisicoes = total_requisicoes + 1
     WHERE id = $1`,
    [apiKeyId]
  );
}

/**
 * Registra log de uso (para análise)
 */
export async function registrarLogApiKey(dados: {
  apiKeyId: number;
  endpoint: string;
  metodo: string;
  ip?: string;
  userAgent?: string;
  statusCode?: number;
  tempoRespostaMs?: number;
}): Promise<void> {
  await query(
    `INSERT INTO bluepoint.bt_api_keys_log 
     (api_key_id, endpoint, metodo, ip, user_agent, status_code, tempo_resposta_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      dados.apiKeyId,
      dados.endpoint,
      dados.metodo,
      dados.ip || null,
      dados.userAgent || null,
      dados.statusCode || null,
      dados.tempoRespostaMs || null,
    ]
  );
}

// =====================================================
// HELPERS
// =====================================================

/**
 * Verifica se a API Key tem determinada permissão
 */
export function temPermissao(apiKey: ApiKey, permissao: string): boolean {
  return apiKey.permissoes.includes('admin') || apiKey.permissoes.includes(permissao);
}

/**
 * Verifica se a API Key pode acessar um módulo
 */
export function podeAcessarModulo(apiKey: ApiKey, modulo: string): boolean {
  return apiKey.modulosPermitidos.includes('*') || apiKey.modulosPermitidos.includes(modulo);
}
