import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/middleware';
import { criarApiKey, listarApiKeys } from '@/lib/api-keys';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';
import { cacheAside, buildListCacheKey, invalidateApiKeyCache, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// Schema de validação para criar API Key
const criarApiKeySchema = z.object({
  nome: z.string().min(3, 'Nome deve ter pelo menos 3 caracteres').max(100),
  descricao: z.string().max(500).optional(),
  prefixo: z.string()
    .min(3, 'Prefixo deve ter pelo menos 3 caracteres')
    .max(30, 'Prefixo deve ter no máximo 30 caracteres')
    .regex(/^[a-zA-Z0-9_]+$/, 'Prefixo deve conter apenas letras, números e underscore')
    .optional(),
  permissoes: z.array(z.enum(['read', 'write', 'admin'])).optional().default(['read']),
  modulosPermitidos: z.array(z.string()).optional().default(['*']),
  rateLimitPorMinuto: z.number().int().min(0).max(10000).optional().default(60),
  rateLimitPorDia: z.number().int().min(0).max(1000000).optional().default(10000),
  ipsPermitidos: z.array(z.string()).optional().default([]),
  empresaId: z.number().int().positive().optional(),
  expiraEm: z.string().datetime().optional(),
});

// Response helper
function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * GET /api/v1/api-keys
 * Lista todas as API Keys (apenas admin)
 */
export async function GET(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const status = searchParams.get('status') || undefined;
      const empresaId = searchParams.get('empresaId');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.API_KEYS, { status, empresaId });

      const apiKeys = await cacheAside(cacheKey, async () => {
        return await listarApiKeys({
          status,
          empresaId: empresaId ? parseInt(empresaId) : undefined,
        });
      }, CACHE_TTL.MEDIUM);

      return jsonResponse({
        success: true,
        data: apiKeys,
        total: apiKeys.length,
      });
    } catch (error) {
      console.error('Erro ao listar API Keys:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao listar API Keys',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

/**
 * POST /api/v1/api-keys
 * Cria nova API Key (apenas admin)
 */
export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({
          success: false,
          error: 'JSON inválido',
          code: 'INVALID_JSON',
        }, 400);
      }

      const validation = criarApiKeySchema.safeParse(body);
      if (!validation.success) {
        return jsonResponse({
          success: false,
          error: 'Erro de validação',
          code: 'VALIDATION_ERROR',
          details: validation.error.issues.map(i => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        }, 422);
      }

      const dados = validation.data;

      const { apiKey, token } = await criarApiKey({
        ...dados,
        expiraEm: dados.expiraEm ? new Date(dados.expiraEm) : undefined,
        criadoPor: user.userId,
      });

      // Invalidar cache
      await invalidateApiKeyCache();

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'api_keys',
        descricao: `API Key criada: ${dados.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { nome: dados.nome, permissoes: dados.permissoes },
      });

      return jsonResponse({
        success: true,
        data: {
          id: apiKey.id,
          nome: apiKey.nome,
          token, // IMPORTANTE: Token completo só é mostrado na criação!
          permissoes: apiKey.permissoes,
          modulosPermitidos: apiKey.modulosPermitidos,
          rateLimitPorMinuto: apiKey.rateLimitPorMinuto,
          rateLimitPorDia: apiKey.rateLimitPorDia,
        },
        mensagem: 'API Key criada com sucesso. ATENÇÃO: Guarde o token, ele não será exibido novamente!',
      }, 201);
    } catch (error) {
      console.error('Erro ao criar API Key:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao criar API Key',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
