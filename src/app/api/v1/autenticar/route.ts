import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyPassword, generateTokenPair } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { loginSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { obterPermissoesEfetivasDoCargo } from '@/lib/permissoes-efetivas';
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
              c.cargo_id,
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

    // Gerar tokens (passa nivelId/cargoId pra que o JWT carregue eles
    // direto e poupe consultas no middleware — cargoId é necessário pra
    // aplicar overrides de permissão por cargo).
    const { token, refreshToken } = await generateTokenPair({
      id: user.id,
      email: user.email,
      tipo: user.tipo,
      nome: user.nome,
      nivelId: user.nivel_acesso_id ?? null,
      cargoId: user.cargo_id ?? null,
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

    // Buscar permissões efetivas (nível + overrides do cargo). god mode
    // (userId === 1) recebe o catálogo inteiro.
    let permissoes: string[];
    if (user.id === 1) {
      const todas = await query(
        `SELECT codigo FROM people.permissoes ORDER BY codigo`
      );
      permissoes = todas.rows.map((r) => r.codigo);
    } else {
      const efetivas = await obterPermissoesEfetivasDoCargo({
        cargoId: user.cargo_id ?? null,
        nivelId: user.nivel_acesso_id ?? null,
        tipoLegado: user.tipo,
      });
      permissoes = efetivas.codigos;
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
