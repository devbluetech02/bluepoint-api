import { NextRequest } from 'next/server';
import { revokeRefreshToken } from '@/lib/auth';
import { noContentResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { refreshTokenSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(refreshTokenSchema, body);
      if (!validation.success) {
        return errorResponse('Refresh token é obrigatório', 400);
      }

      const { refreshToken } = validation.data;

      // Revogar refresh token
      await revokeRefreshToken(refreshToken);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'LOGOUT',
        modulo: 'autenticacao',
        descricao: `Logout realizado: ${user.email}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro no logout:', error);
      return serverErrorResponse('Erro ao realizar logout');
    }
  });
}
