import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyPassword, generateTokenPair } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { loginSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Validar body
    const validation = validateBody(loginSchema, body);
    if (!validation.success) {
      return errorResponse('Credenciais inválidas', 400);
    }

    const { email, senha } = validation.data;

    // Buscar usuário
    const result = await query(
      `SELECT id, nome, email, cpf, senha_hash, tipo, status, foto_url, permite_ponto_mobile
       FROM bluepoint.bt_colaboradores 
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return errorResponse('Email ou senha inválidos', 401);
    }

    const user = result.rows[0];

    // Verificar se está ativo
    if (user.status !== 'ativo') {
      return errorResponse('Usuário inativo', 401);
    }

    // Verificar senha
    const isValidPassword = await verifyPassword(senha, user.senha_hash);
    if (!isValidPassword) {
      return errorResponse('Email ou senha inválidos', 401);
    }

    // Gerar tokens
    const { token, refreshToken } = await generateTokenPair({
      id: user.id,
      email: user.email,
      tipo: user.tipo,
      nome: user.nome,
    });

    // Registrar auditoria
    await registrarAuditoria({
      usuarioId: user.id,
      acao: 'LOGIN',
      modulo: 'autenticacao',
      descricao: `Login realizado: ${user.email}`,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
    });

    // Buscar permissões concedidas ao tipo do usuário
    const permResult = await query(
      `SELECT p.codigo
       FROM bt_tipo_usuario_permissoes tp
       JOIN bt_permissoes p ON tp.permissao_id = p.id
       WHERE tp.tipo_usuario = $1 AND tp.concedido = true
       ORDER BY p.codigo`,
      [user.tipo]
    );
    const permissoes = permResult.rows.map((r) => r.codigo);

    return successResponse({
      token,
      refreshToken,
      usuario: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        cpf: user.cpf,
        tipo: user.tipo,
        foto: user.foto_url,
        permitePontoMobile: user.permite_ponto_mobile ?? false,
        permissoes,
      },
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return serverErrorResponse('Erro ao realizar login');
  }
}
