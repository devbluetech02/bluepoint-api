import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader, JWTPayload, isSuperAdmin, resolveNivelFromColaborador } from './auth';
import { forbiddenResponse } from './api-response';
import { validarApiKey, registrarUsoApiKey, ApiKey, temPermissao } from './api-keys';
import { TIPOS_GESTAO } from '@/types';

// Resolve o nível de acesso do usuário: prioriza o JWT, cai para o banco se ausente.
// API Keys (userId negativo) não têm cargo/nivel — retorna null.
async function getNivelIdFromUser(user: JWTPayload): Promise<number | null> {
  if (typeof user.nivelId === 'number') return user.nivelId;
  if (user.userId < 0) return null;
  return resolveNivelFromColaborador(user.userId);
}

// Função local para resposta de não autorizado com código customizado
function unauthorizedResponse(message: string, code?: string): NextResponse {
  return NextResponse.json(
    { success: false, error: message, code: code || 'UNAUTHORIZED' },
    { status: 401 }
  );
}

export interface AuthenticatedRequest extends NextRequest {
  user?: JWTPayload;
}

// =====================================================
// CONTEXTO DE AUTENTICAÇÃO
// =====================================================

export interface AuthContext {
  tipo: 'jwt' | 'api_key';
  user?: JWTPayload;      // Preenchido se for JWT
  apiKey?: ApiKey;        // Preenchido se for API Key
}

// =====================================================
// HELPER: Detectar tipo de token
// =====================================================

function detectTokenType(token: string): 'jwt' | 'api_key' | 'unknown' {
  // JWT tem formato: header.payload.signature (contém pontos)
  if (token.includes('.')) return 'jwt';
  
  // API Key tem formato: prefixo_hash (contém underscore, sem pontos, min 36 chars)
  if (token.includes('_') && token.length >= 36) return 'api_key';
  
  return 'unknown';
}

// =====================================================
// HELPER: Converter API Key em JWTPayload-like
// =====================================================

/**
 * Converte uma API Key em um objeto compatível com JWTPayload
 * para manter compatibilidade com handlers existentes
 */
function apiKeyToJwtPayload(apiKey: ApiKey): JWTPayload {
  // Mapear permissões para tipo de usuário
  let tipo: 'admin' | 'gestor' | 'colaborador' = 'colaborador';
  
  if (temPermissao(apiKey, 'admin')) {
    tipo = 'admin';
  } else if (temPermissao(apiKey, 'write')) {
    tipo = 'gestor';
  }

  return {
    userId: -apiKey.id, // ID negativo para identificar que é API Key
    nome: `[API] ${apiKey.nome}`,
    email: `api-key-${apiKey.id}@system`,
    tipo,
  };
}

// =====================================================
// HELPER: Obter IP do cliente
// =====================================================

function getClientIpFromRequest(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');

  if (cfIp) return cfIp;
  if (forwarded) return forwarded.split(',')[0].trim();
  if (realIp) return realIp;

  return 'unknown';
}

// =====================================================
// MIDDLEWARE DE AUTENTICAÇÃO (JWT + API KEY)
// =====================================================

/**
 * Middleware de autenticação universal
 * Aceita JWT de usuários logados OU API Keys de aplicações externas
 */
export async function withAuth(
  request: NextRequest,
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader) {
    return unauthorizedResponse('Token não fornecido');
  }

  const token = extractTokenFromHeader(authHeader) || authHeader.replace('Bearer ', '');
  const tokenType = detectTokenType(token);

  // Validar como API Key
  if (tokenType === 'api_key') {
    const clientIp = getClientIpFromRequest(request);
    const validation = await validarApiKey(token, clientIp);

    if (validation.valida && validation.apiKey) {
      // Registrar uso (async, não bloqueia)
      registrarUsoApiKey(validation.apiKey.id).catch(console.error);
      
      // Converter API Key para formato JWTPayload
      const userLike = apiKeyToJwtPayload(validation.apiKey);
      return handler(request, userLike);
    }

    return unauthorizedResponse(validation.erro || 'API Key inválida', validation.code);
  }

  // Validar como JWT
  const payload = verifyToken(token);
  if (!payload) {
    return unauthorizedResponse('Token inválido ou expirado');
  }

  return handler(request, payload);
}

// =====================================================
// MIDDLEWARE DE AUTORIZAÇÃO POR ROLE (JWT + API KEY)
// =====================================================

/**
 * Middleware de autorização por role
 * Para JWT: verifica o tipo de usuário
 * Para API Key: verifica permissões (admin→admin, write→gestor, read→colaborador)
 */
export async function withRole(
  request: NextRequest,
  allowedRoles: string[],
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  return withAuth(request, async (req, user) => {
    // Verificar se o role do usuário (ou role equivalente da API Key) está permitido
    if (!allowedRoles.includes(user.tipo)) {
      return forbiddenResponse('Você não tem permissão para acessar este recurso');
    }
    return handler(req, user);
  });
}

/**
 * Middleware para admin apenas
 * Aceita: usuário com nivelId === 3 OU tipo === 'admin' (fallback) OU userId === 1 (god mode)
 */
export async function withAdmin(
  request: NextRequest,
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  return withAuth(request, async (req, user) => {
    if (isSuperAdmin(user)) return handler(req, user);

    const nivelId = await getNivelIdFromUser(user);
    if (nivelId !== null && nivelId >= 3) return handler(req, user);

    // Fallback ao sistema legado (JWTs antigos, API Keys, e cargos ainda não reclassificados)
    if (user.tipo === 'admin') return handler(req, user);

    return forbiddenResponse('Você não tem permissão para acessar este recurso');
  });
}

/**
 * Middleware para cargos de gestão ou admin
 * Aceita: nivelId >= 2 OU tipo em TIPOS_GESTAO (fallback) OU god mode
 */
export async function withGestor(
  request: NextRequest,
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  return withAuth(request, async (req, user) => {
    if (isSuperAdmin(user)) return handler(req, user);

    const nivelId = await getNivelIdFromUser(user);
    if (nivelId !== null && nivelId >= 2) return handler(req, user);

    if ((TIPOS_GESTAO as readonly string[]).includes(user.tipo)) return handler(req, user);

    return forbiddenResponse('Você não tem permissão para acessar este recurso');
  });
}

/**
 * Middleware para endpoints de admissão
 * Aceita: usuários provisórios (tipo='provisorio') OU mesmas regras do withGestor
 */
export async function withAdmissao(
  request: NextRequest,
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  return withAuth(request, async (req, user) => {
    if (user.tipo === 'provisorio') return handler(req, user);
    if (isSuperAdmin(user)) return handler(req, user);

    const nivelId = await getNivelIdFromUser(user);
    if (nivelId !== null && nivelId >= 2) return handler(req, user);

    if ((TIPOS_GESTAO as readonly string[]).includes(user.tipo)) return handler(req, user);

    return forbiddenResponse('Você não tem permissão para acessar este recurso');
  });
}

// =====================================================
// MIDDLEWARE DE VERIFICAÇÃO DE PERMISSÃO GRANULAR
// =====================================================

/**
 * Middleware que verifica se o usuário tem uma permissão específica.
 * Consulta nivel_acesso_permissoes pelo nível do usuário; cai pra
 * tipo_usuario_permissoes (sistema legado) se a primeira não conceder
 * — útil enquanto cargos ainda não foram reclassificados via UI.
 * userId === 1 (god mode) bypassa toda checagem.
 *
 * Exemplo de uso:
 *   withPermission(request, 'colaboradores:criar', async (req, user) => { ... })
 */
export async function withPermission(
  request: NextRequest,
  codigoPermissao: string,
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  return withAuth(request, async (req, user) => {
    if (isSuperAdmin(user)) return handler(req, user);

    const { query: dbQuery } = await import('./db');

    const nivelId = await getNivelIdFromUser(user);
    if (nivelId !== null) {
      const novo = await dbQuery(
        `SELECT 1 FROM nivel_acesso_permissoes nap
         JOIN permissoes p ON nap.permissao_id = p.id
         WHERE nap.nivel_id = $1 AND p.codigo = $2 AND nap.concedido = true
         LIMIT 1`,
        [nivelId, codigoPermissao]
      );
      if (novo.rows.length > 0) return handler(req, user);
    }

    // Fallback ao sistema legado (tipo_usuario_permissoes)
    const legado = await dbQuery(
      `SELECT 1 FROM tipo_usuario_permissoes tp
       JOIN permissoes p ON tp.permissao_id = p.id
       WHERE tp.tipo_usuario = $1 AND p.codigo = $2 AND tp.concedido = true
       LIMIT 1`,
      [user.tipo, codigoPermissao]
    );
    if (legado.rows.length > 0) return handler(req, user);

    return forbiddenResponse(
      `Permissão '${codigoPermissao}' não concedida`
    );
  });
}

/**
 * Middleware que verifica se o usuário tem PELO MENOS UMA das permissões informadas.
 */
export async function withAnyPermission(
  request: NextRequest,
  codigosPermissao: string[],
  handler: (req: NextRequest, user: JWTPayload) => Promise<Response>
): Promise<Response> {
  return withAuth(request, async (req, user) => {
    if (isSuperAdmin(user)) return handler(req, user);

    const { query: dbQuery } = await import('./db');

    const nivelId = await getNivelIdFromUser(user);
    if (nivelId !== null) {
      const novo = await dbQuery(
        `SELECT 1 FROM nivel_acesso_permissoes nap
         JOIN permissoes p ON nap.permissao_id = p.id
         WHERE nap.nivel_id = $1 AND p.codigo = ANY($2) AND nap.concedido = true
         LIMIT 1`,
        [nivelId, codigosPermissao]
      );
      if (novo.rows.length > 0) return handler(req, user);
    }

    const legado = await dbQuery(
      `SELECT 1 FROM tipo_usuario_permissoes tp
       JOIN permissoes p ON tp.permissao_id = p.id
       WHERE tp.tipo_usuario = $1 AND p.codigo = ANY($2) AND tp.concedido = true
       LIMIT 1`,
      [user.tipo, codigosPermissao]
    );
    if (legado.rows.length > 0) return handler(req, user);

    return forbiddenResponse('Você não possui nenhuma das permissões necessárias');
  });
}

// =====================================================
// MIDDLEWARE AVANÇADO (com contexto completo)
// =====================================================

/**
 * Middleware que aceita JWT ou API Key e retorna contexto completo
 * Use quando precisar saber exatamente qual tipo de autenticação foi usado
 */
export async function withApiAuth(
  request: NextRequest,
  handler: (req: NextRequest, auth: AuthContext) => Promise<Response>,
  options?: {
    modulo?: string;           // Módulo para validar permissão da API Key
    permissaoMinima?: string;  // Permissão mínima necessária (read, write, admin)
  }
): Promise<Response> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return unauthorizedResponse('Token não fornecido');
  }

  const token = extractTokenFromHeader(authHeader) || authHeader.replace('Bearer ', '');
  const tokenType = detectTokenType(token);

  // Validar como API Key
  if (tokenType === 'api_key') {
    const clientIp = getClientIpFromRequest(request);
    const validation = await validarApiKey(token, clientIp, options?.modulo);

    if (validation.valida && validation.apiKey) {
      // Verificar permissão mínima
      if (options?.permissaoMinima && !temPermissao(validation.apiKey, options.permissaoMinima)) {
        return forbiddenResponse('API Key não tem permissão para esta operação');
      }

      // Registrar uso (async, não bloqueia)
      registrarUsoApiKey(validation.apiKey.id).catch(console.error);

      return handler(request, {
        tipo: 'api_key',
        apiKey: validation.apiKey,
      });
    }
    
    return unauthorizedResponse(validation.erro || 'Token inválido', validation.code);
  }

  // Validar como JWT
  const payload = verifyToken(token);
  if (!payload) {
    return unauthorizedResponse('Token inválido ou expirado');
  }

  return handler(request, {
    tipo: 'jwt',
    user: payload,
  });
}

/**
 * Middleware que aceita JWT ou API Key com validação de role/permissão
 */
export async function withApiAuthRole(
  request: NextRequest,
  allowedRoles: string[],  // Roles permitidos para JWT
  requiredPermission: string, // Permissão necessária para API Key (read, write, admin)
  handler: (req: NextRequest, auth: AuthContext) => Promise<Response>,
  modulo?: string
): Promise<Response> {
  return withApiAuth(
    request,
    async (req, auth) => {
      // Se for JWT, verificar role
      if (auth.tipo === 'jwt' && auth.user) {
        if (!allowedRoles.includes(auth.user.tipo)) {
          return forbiddenResponse('Você não tem permissão para acessar este recurso');
        }
      }

      // Se for API Key, verificar permissão
      if (auth.tipo === 'api_key' && auth.apiKey) {
        if (!temPermissao(auth.apiKey, requiredPermission)) {
          return forbiddenResponse('API Key não tem permissão para esta operação');
        }
      }

      return handler(req, auth);
    },
    { modulo }
  );
}

// =====================================================
// MIDDLEWARE LEGADO DE BIOMETRIA (Compatibilidade)
// =====================================================

// Token fixo para acesso de sistemas externos aos endpoints de biometria
const BIOMETRIA_API_TOKEN = process.env.BIOMETRIA_API_TOKEN || 'bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';

/**
 * Middleware para endpoints de biometria (aceita token fixo OU JWT OU API Key)
 * @deprecated Use withAuth para novos endpoints
 */
export async function withBiometriaAuth(
  request: NextRequest,
  handler: (req: NextRequest, isApiToken: boolean, user?: JWTPayload) => Promise<Response>
): Promise<Response> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return unauthorizedResponse('Token não fornecido');
  }

  const token = extractTokenFromHeader(authHeader) || authHeader.replace('Bearer ', '');

  // Verificar se é o token fixo de API (legado)
  if (token === BIOMETRIA_API_TOKEN) {
    return handler(request, true, undefined);
  }

  const tokenType = detectTokenType(token);

  // Verificar se é uma API Key do banco
  if (tokenType === 'api_key') {
    const clientIp = getClientIpFromRequest(request);
    const validation = await validarApiKey(token, clientIp, 'biometria');

    if (validation.valida && validation.apiKey) {
      registrarUsoApiKey(validation.apiKey.id).catch(console.error);
      return handler(request, true, undefined);
    }
  }

  // Validar como JWT
  const payload = verifyToken(token);
  if (!payload) {
    return unauthorizedResponse('Token inválido ou expirado');
  }

  return handler(request, false, payload);
}

// =====================================================
// HELPERS PÚBLICOS
// =====================================================

/**
 * Helper para obter usuário do request (quando já autenticado)
 */
export function getUserFromRequest(request: NextRequest): JWTPayload | null {
  const authHeader = request.headers.get('authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) return null;

  return verifyToken(token);
}

/**
 * Helper para obter informações de autenticação para logs
 */
export function getAuthInfo(auth: AuthContext): { tipo: string; id: number | string; nome: string } {
  if (auth.tipo === 'jwt' && auth.user) {
    return {
      tipo: 'usuario',
      id: auth.user.userId,
      nome: auth.user.nome,
    };
  }

  if (auth.tipo === 'api_key' && auth.apiKey) {
    return {
      tipo: 'api_key',
      id: auth.apiKey.id,
      nome: auth.apiKey.nome,
    };
  }

  return { tipo: 'desconhecido', id: 0, nome: 'N/A' };
}

/**
 * Helper para verificar se a autenticação veio de API Key
 */
export function isApiKeyAuth(user: JWTPayload): boolean {
  return user.userId < 0; // IDs negativos indicam API Key
}

/**
 * Extrai o ID real da API Key a partir do userId negativo
 */
export function getApiKeyId(user: JWTPayload): number | null {
  if (user.userId < 0) {
    return Math.abs(user.userId);
  }
  return null;
}
