import { NextRequest } from 'next/server';
import { validateRefreshToken, revokeRefreshToken, generateTokenPair } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { refreshTokenSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    const validation = validateBody(refreshTokenSchema, body);
    if (!validation.success) {
      return errorResponse('Refresh token é obrigatório', 400);
    }

    const { refreshToken } = validation.data;

    // Validar refresh token
    const tokenData = await validateRefreshToken(refreshToken);
    if (!tokenData) {
      return errorResponse('Refresh token inválido ou expirado', 401);
    }

    // Revogar token antigo
    await revokeRefreshToken(refreshToken);

    // Gerar novos tokens
    const { token: newToken, refreshToken: newRefreshToken } = await generateTokenPair({
      id: tokenData.id,
      email: tokenData.email,
      tipo: tokenData.tipo,
      nome: tokenData.nome,
    });

    await registrarAuditoria({
      usuarioId: tokenData.id,
      acao: 'UPDATE',
      modulo: 'tokens',
      descricao: `Token renovado para ${tokenData.email}`,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      dadosNovos: { email: tokenData.email, tipo: tokenData.tipo },
    });

    return successResponse({
      token: newToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    console.error('Erro ao renovar token:', error);
    return serverErrorResponse('Erro ao renovar token');
  }
}
