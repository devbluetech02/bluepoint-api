import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { generateProvisionalToken } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { loginCpfSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { isValidCPF } from '@/lib/utils';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const validation = validateBody(loginCpfSchema, body);
    if (!validation.success) {
      return errorResponse('CPF inválido', 400);
    }

    const cpfLimpo = validation.data.cpf.replace(/\D/g, '');
    if (!isValidCPF(cpfLimpo)) {
      return errorResponse('CPF inválido', 400);
    }

    const result = await query(
      `SELECT up.id, up.nome, up.cpf, up.status, up.expira_em,
              up.empresa_id, e.nome_fantasia AS empresa_nome,
              up.cargo_id,   c.nome AS cargo_nome
         FROM people.usuarios_provisorios up
         LEFT JOIN people.empresas e ON e.id = up.empresa_id
         LEFT JOIN people.cargos   c ON c.id = up.cargo_id
        WHERE up.cpf = $1`,
      [cpfLimpo]
    );

    if (result.rows.length === 0) {
      return errorResponse('CPF não encontrado', 401);
    }

    const usuario = result.rows[0];

    if (usuario.status !== 'ativo') {
      return errorResponse('Usuário inativo', 401);
    }

    if (usuario.expira_em && new Date(usuario.expira_em) < new Date()) {
      return errorResponse('Acesso expirado', 401);
    }

    const token = generateProvisionalToken({
      id:   usuario.id,
      nome: usuario.nome,
      cpf:  usuario.cpf,
    });

    await registrarAuditoria(buildAuditParams(request, { userId: usuario.id, nome: usuario.nome, email: `provisorio_${usuario.cpf}@sistema` }, {
      acao: 'login',
      modulo: 'autenticacao',
      descricao: `Login provisório via CPF: ${usuario.cpf}`,
    })).catch(() => { /* auditoria não-bloqueante */ });

    return successResponse({
      token,
      tipo: 'provisorio',
      usuario: {
        id:       usuario.id,
        nome:     usuario.nome,
        cpf:      usuario.cpf,
        expiraEm: usuario.expira_em,
        empresa:  usuario.empresa_id ? { id: usuario.empresa_id, nome: usuario.empresa_nome } : null,
        cargo:    usuario.cargo_id   ? { id: usuario.cargo_id,   nome: usuario.cargo_nome   } : null,
      },
    });
  } catch (error) {
    console.error('Erro no login provisório:', error);
    return serverErrorResponse('Erro ao realizar login');
  }
}
