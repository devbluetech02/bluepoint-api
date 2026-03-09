import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/middleware';
import { obterApiKey, atualizarApiKey, revogarApiKey, regenerarApiToken } from '@/lib/api-keys';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

interface Params {
  params: Promise<{ id: string }>;
}

// Schema de validação para atualizar API Key
const atualizarApiKeySchema = z.object({
  nome: z.string().min(3).max(100).optional(),
  descricao: z.string().max(500).optional(),
  permissoes: z.array(z.enum(['read', 'write', 'admin'])).optional(),
  modulosPermitidos: z.array(z.string()).optional(),
  rateLimitPorMinuto: z.number().int().min(0).max(10000).optional(),
  rateLimitPorDia: z.number().int().min(0).max(1000000).optional(),
  ipsPermitidos: z.array(z.string()).optional(),
  status: z.enum(['ativo', 'inativo']).optional(),
  expiraEm: z.string().datetime().nullable().optional(),
});

// Response helper
function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * GET /api/v1/api-keys/{id}
 * Obtém detalhes de uma API Key (apenas admin)
 */
export async function GET(request: NextRequest, { params }: Params) {
  return withAdmin(request, async () => {
    try {
      const { id } = await params;
      const apiKeyId = parseInt(id);

      if (isNaN(apiKeyId)) {
        return jsonResponse({
          success: false,
          error: 'ID inválido',
          code: 'INVALID_ID',
        }, 400);
      }

      const apiKey = await obterApiKey(apiKeyId);

      if (!apiKey) {
        return jsonResponse({
          success: false,
          error: 'API Key não encontrada',
          code: 'NOT_FOUND',
        }, 404);
      }

      return jsonResponse({
        success: true,
        data: apiKey,
      });
    } catch (error) {
      console.error('Erro ao obter API Key:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao obter API Key',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

/**
 * PUT /api/v1/api-keys/{id}
 * Atualiza uma API Key (apenas admin)
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const apiKeyId = parseInt(id);

      if (isNaN(apiKeyId)) {
        return jsonResponse({
          success: false,
          error: 'ID inválido',
          code: 'INVALID_ID',
        }, 400);
      }

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

      const validation = atualizarApiKeySchema.safeParse(body);
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

      // Verificar se API Key existe
      const apiKeyAtual = await obterApiKey(apiKeyId);
      if (!apiKeyAtual) {
        return jsonResponse({
          success: false,
          error: 'API Key não encontrada',
          code: 'NOT_FOUND',
        }, 404);
      }

      const atualizado = await atualizarApiKey(apiKeyId, {
        ...dados,
        expiraEm: dados.expiraEm === null ? null : dados.expiraEm ? new Date(dados.expiraEm) : undefined,
      });

      if (!atualizado) {
        return jsonResponse({
          success: false,
          error: 'Não foi possível atualizar a API Key',
          code: 'UPDATE_FAILED',
        }, 400);
      }

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'api_keys',
        descricao: `API Key atualizada: ${apiKeyAtual.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { nome: apiKeyAtual.nome },
        dadosNovos: dados,
      });

      const apiKeyAtualizada = await obterApiKey(apiKeyId);

      return jsonResponse({
        success: true,
        data: apiKeyAtualizada,
        mensagem: 'API Key atualizada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar API Key:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao atualizar API Key',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

/**
 * DELETE /api/v1/api-keys/{id}
 * Revoga uma API Key (apenas admin)
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const apiKeyId = parseInt(id);

      if (isNaN(apiKeyId)) {
        return jsonResponse({
          success: false,
          error: 'ID inválido',
          code: 'INVALID_ID',
        }, 400);
      }

      // Verificar se API Key existe
      const apiKey = await obterApiKey(apiKeyId);
      if (!apiKey) {
        return jsonResponse({
          success: false,
          error: 'API Key não encontrada',
          code: 'NOT_FOUND',
        }, 404);
      }

      const revogado = await revogarApiKey(apiKeyId);

      if (!revogado) {
        return jsonResponse({
          success: false,
          error: 'Não foi possível revogar a API Key',
          code: 'REVOKE_FAILED',
        }, 400);
      }

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'api_keys',
        descricao: `API Key revogada: ${apiKey.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: apiKeyId, nome: apiKey.nome },
      });

      return jsonResponse({
        success: true,
        mensagem: 'API Key revogada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao revogar API Key:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao revogar API Key',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
