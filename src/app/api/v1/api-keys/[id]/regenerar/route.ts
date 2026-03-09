import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/middleware';
import { obterApiKey, regenerarApiToken } from '@/lib/api-keys';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// Response helper
function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * POST /api/v1/api-keys/{id}/regenerar
 * Regenera o token de uma API Key (apenas admin)
 * O token antigo é invalidado imediatamente
 */
export async function POST(request: NextRequest, { params }: Params) {
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

      // Regenerar token
      const novoToken = await regenerarApiToken(apiKeyId);

      if (!novoToken) {
        return jsonResponse({
          success: false,
          error: 'Não foi possível regenerar o token. Verifique se a API Key está ativa.',
          code: 'REGENERATE_FAILED',
        }, 400);
      }

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'api_keys',
        descricao: `Token regenerado para API Key: ${apiKey.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { apiKeyId, tokenRegenerado: true },
      });

      return jsonResponse({
        success: true,
        data: {
          id: apiKeyId,
          nome: apiKey.nome,
          token: novoToken, // Token novo só é mostrado aqui!
        },
        mensagem: 'Token regenerado com sucesso. ATENÇÃO: O token antigo foi invalidado. Guarde o novo token, ele não será exibido novamente!',
      });
    } catch (error) {
      console.error('Erro ao regenerar token:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao regenerar token',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
