import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { generatePasswordResetToken } from '@/lib/auth';
import { sendPasswordResetEmail } from '@/lib/email';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { solicitarRecuperacaoSenhaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    const validation = validateBody(solicitarRecuperacaoSenhaSchema, body);
    if (!validation.success) {
      return errorResponse('Email inválido', 400);
    }

    const { email } = validation.data;

    // Buscar usuário
    const result = await query(
      `SELECT id, nome, email, status
       FROM people.colaboradores 
       WHERE email = $1`,
      [email]
    );

    // Sempre retornar sucesso por segurança (não revelar se email existe)
    if (result.rows.length === 0 || result.rows[0].status !== 'ativo') {
      return successResponse({
        mensagem: 'Se o email estiver cadastrado, você receberá as instruções de recuperação.',
        emailEnviado: true,
      });
    }

    const user = result.rows[0];

    // Gerar token de recuperação
    const token = await generatePasswordResetToken(user.id);

    // Enviar email
    const emailEnviado = await sendPasswordResetEmail(user.email, token, user.nome);

    await registrarAuditoria({
      usuarioId: user.id,
      acao: 'criar',
      modulo: 'autenticacao',
      descricao: `Solicitação de recuperação de senha para ${user.email}`,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      dadosNovos: { email: user.email, emailEnviado },
    });

    return successResponse({
      mensagem: 'Se o email estiver cadastrado, você receberá as instruções de recuperação.',
      emailEnviado,
    });
  } catch (error) {
    console.error('Erro ao solicitar recuperação de senha:', error);
    return serverErrorResponse('Erro ao processar solicitação');
  }
}
