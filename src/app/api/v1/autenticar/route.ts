import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyPassword, generateTokenPair } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { loginSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Validar body
    const validation = validateBody(loginSchema, body);
    if (!validation.success) {
      return errorResponse('Credenciais inválidas', 400);
    }

    const { email, senha } = validation.data;

    // Buscar usuário (incluindo o nível de acesso derivado do cargo)
    const result = await query(
      `SELECT c.id, c.nome, c.email, c.cpf, c.senha_hash, c.tipo, c.status,
              c.foto_url, c.permite_ponto_mobile,
              cg.nivel_acesso_id
       FROM people.colaboradores c
       LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
       WHERE c.email = $1`,
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

    // Gerar tokens (passa nivelId pra que o JWT carregue ele direto e
    // poupe consultas no middleware)
    const { token, refreshToken } = await generateTokenPair({
      id: user.id,
      email: user.email,
      tipo: user.tipo,
      nome: user.nome,
      nivelId: user.nivel_acesso_id ?? null,
    });

    // Registrar auditoria
    await registrarAuditoria(buildAuditParams(request, { userId: user.id, nome: user.nome, email: user.email }, {
      acao: 'login',
      modulo: 'autenticacao',
      descricao: `Login realizado: ${user.email}`,
      colaboradorId: user.id,
      colaboradorNome: user.nome,
    }));

    // Buscar dados do nível (id/nome/descricao) — pode ser null se cargo não tiver nivel
    let nivel: { id: number; nome: string; descricao: string | null } | null = null;
    if (user.nivel_acesso_id) {
      const nivelResult = await query(
        `SELECT id, nome, descricao FROM people.niveis_acesso WHERE id = $1`,
        [user.nivel_acesso_id]
      );
      if (nivelResult.rows.length > 0) {
        const r = nivelResult.rows[0];
        nivel = { id: r.id, nome: r.nome, descricao: r.descricao };
      }
    }

    // Buscar permissões concedidas: união entre o sistema novo (nível) e o
    // legado (tipo). god mode (userId === 1) recebe o catálogo inteiro.
    let permissoes: string[];
    if (user.id === 1) {
      const todas = await query(
        `SELECT codigo FROM people.permissoes ORDER BY codigo`
      );
      permissoes = todas.rows.map((r) => r.codigo);
    } else {
      const permResult = await query(
        `SELECT DISTINCT p.codigo
         FROM people.permissoes p
         WHERE p.id IN (
           SELECT permissao_id FROM people.nivel_acesso_permissoes
             WHERE nivel_id = $1 AND concedido = true
           UNION
           SELECT permissao_id FROM people.tipo_usuario_permissoes
             WHERE tipo_usuario = $2 AND concedido = true
         )
         ORDER BY p.codigo`,
        [user.nivel_acesso_id, user.tipo]
      );
      permissoes = permResult.rows.map((r) => r.codigo);
    }

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
        nivel,
        permissoes,
      },
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return serverErrorResponse('Erro ao realizar login');
  }
}
