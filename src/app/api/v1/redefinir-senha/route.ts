import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { validatePasswordResetToken, markPasswordResetTokenAsUsed, hashPassword, revokeAllUserTokens } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { redefinirSenhaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    const validation = validateBody(redefinirSenhaSchema, body);
    if (!validation.success) {
      return errorResponse('Dados inválidos', 400);
    }

    const { token, novaSenha } = validation.data;

    // Validar token
    const tokenData = await validatePasswordResetToken(token);
    if (!tokenData) {
      return errorResponse('Token inválido ou expirado', 400);
    }

    // Hash da nova senha
    const senhaHash = await hashPassword(novaSenha);

    // Atualizar senha
    await query(
      `UPDATE bluepoint.bt_colaboradores SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2`,
      [senhaHash, tokenData.usuario_id]
    );

    // Marcar token como usado
    await markPasswordResetTokenAsUsed(token);

    // Revogar todos os refresh tokens do usuário
    await revokeAllUserTokens(tokenData.usuario_id);

    // Registrar auditoria
    await registrarAuditoria({
      usuarioId: tokenData.usuario_id,
      acao: 'editar',
      modulo: 'autenticacao',
      descricao: `Senha redefinida via recuperação: ${tokenData.email}`,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
    });

    return successResponse({
      mensagem: 'Senha redefinida com sucesso',
      sucesso: true,
    });
  } catch (error) {
    console.error('Erro ao redefinir senha:', error);
    return serverErrorResponse('Erro ao redefinir senha');
  }
}
