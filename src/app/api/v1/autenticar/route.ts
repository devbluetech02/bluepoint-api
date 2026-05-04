import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyPassword, generateTokenPair, generateProvisionalToken } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { loginSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { obterPermissoesEfetivasDoCargo } from '@/lib/permissoes-efetivas';
import { calcularBiometriaPrompt } from '@/lib/primeiro-acesso';

// Status da solicitação de admissão para os quais o login email+senha
// deve redirecionar o candidato para o fluxo de pré-admissão (em vez de
// devolver 401). Status 'admitido' fica de fora — nesse ponto o registro
// já foi promovido para colaborador e o login normal funciona.
// 'rejeitado' e 'aso_reprovado' também ficam de fora — fim de linha.
const STATUS_PRE_ADMISSAO_LOGAVEIS = new Set([
  'aguardando_rh',
  'correcao_solicitada',
  'aso_solicitado',
  'aso_recebido',
  'em_teste',
  'assinatura_solicitada',
  'contrato_assinado',
]);

// Mapeia status para a rota client-side onde o candidato precisa ser jogado.
// O front (mobile + web) lê `rotaSugerida` da resposta e faz pushReplacement.
function rotaSugeridaPorStatus(status: string): string {
  if (status === 'aso_solicitado' || status === 'aso_recebido') return '/aso-info';
  if (status === 'correcao_solicitada') return '/pre-admissao/correcao';
  return '/pre-admissao';
}

interface PreAdmissaoLoginRow {
  id: string;
  status: string;
  senha_hash: string | null;
  usuario_provisorio_id: number | null;
  prov_nome: string | null;
  prov_cpf: string | null;
  clinica_id: number | null;
  clinica_nome: string | null;
  clinica_logradouro: string | null;
  clinica_numero: string | null;
  clinica_bairro: string | null;
  clinica_cidade: string | null;
  clinica_estado: string | null;
  clinica_cep: string | null;
  data_exame_aso: Date | null;
  mensagem_aso: string | null;
}

function montarAsoInfo(row: PreAdmissaoLoginRow): Record<string, unknown> | null {
  if (!(row.status === 'aso_solicitado' || row.status === 'aso_recebido')) return null;
  if (!row.clinica_id) return null;
  const partes: string[] = [];
  if (row.clinica_logradouro) partes.push(row.clinica_logradouro);
  if (row.clinica_numero) partes.push(`, ${row.clinica_numero}`);
  if (row.clinica_bairro) partes.push(` — ${row.clinica_bairro}`);
  if (row.clinica_cidade && row.clinica_estado) partes.push(`, ${row.clinica_cidade}/${row.clinica_estado}`);
  else if (row.clinica_cidade) partes.push(`, ${row.clinica_cidade}`);
  if (row.clinica_cep) partes.push(`, ${row.clinica_cep}`);
  const aso: Record<string, unknown> = {
    solicitacaoId: row.id,
    clinica:       row.clinica_nome,
    endereco:      partes.join(''),
  };
  if (row.data_exame_aso) aso.dataHora = new Date(row.data_exame_aso).toISOString();
  if (row.mensagem_aso)   aso.observacoes = row.mensagem_aso;
  return aso;
}

/**
 * Após falha do login normal (email não bate em colaboradores OU senha
 * errada), tenta resolver via pré-admissão. Se houver uma solicitação ATIVA
 * com email+senha que batem, devolve 200 com `tipo='pre_admissao'` e o
 * payload de redirecionamento para o cliente continuar o fluxo (ex.: tela
 * ASO). Caso contrário devolve `null` e o handler principal segue com 401.
 */
async function tentarLoginPreAdmissao(
  request: NextRequest,
  email: string,
  senha: string
): Promise<Response | null> {
  const result = await query<PreAdmissaoLoginRow>(
    `SELECT
       s.id,
       s.status,
       s.pre_admissao_senha_hash       AS senha_hash,
       s.usuario_provisorio_id,
       up.nome                         AS prov_nome,
       up.cpf                          AS prov_cpf,
       s.clinica_id,
       cl.nome                         AS clinica_nome,
       cl.logradouro                   AS clinica_logradouro,
       cl.numero                       AS clinica_numero,
       cl.bairro                       AS clinica_bairro,
       cl.cidade                       AS clinica_cidade,
       cl.estado                       AS clinica_estado,
       cl.cep                          AS clinica_cep,
       s.data_exame_aso,
       s.mensagem_aso
       FROM people.solicitacoes_admissao s
       LEFT JOIN people.usuarios_provisorios up ON up.id = s.usuario_provisorio_id
       LEFT JOIN people.clinicas cl              ON cl.id = s.clinica_id
      WHERE LOWER(s.pre_admissao_email) = LOWER($1)
        AND s.status = ANY($2::text[])
      ORDER BY s.criado_em DESC
      LIMIT 1`,
    [email, Array.from(STATUS_PRE_ADMISSAO_LOGAVEIS)]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!row.senha_hash) return null;

  const ok = await verifyPassword(senha, row.senha_hash);
  if (!ok) return null;

  // Token provisório só é emitido se houver usuario_provisorio_id (caso
  // padrão do fluxo atual). Sem ele, cliente cai no PrimeiroAcessoScreen
  // e logra com CPF — ainda assim retornamos rotaSugerida para guiar.
  let tokenProvisorio: string | null = null;
  if (row.usuario_provisorio_id && row.prov_nome && row.prov_cpf) {
    tokenProvisorio = generateProvisionalToken({
      id:   row.usuario_provisorio_id,
      nome: row.prov_nome,
      cpf:  row.prov_cpf,
    });
  }

  await registrarAuditoria(buildAuditParams(request, { userId: 0, nome: row.prov_nome ?? '', email }, {
    acao: 'login',
    modulo: 'autenticacao',
    descricao: `Login email+senha redirecionado para pré-admissão (status=${row.status}, solicitacao=${row.id})`,
  }));

  return successResponse({
    tipo:              'pre_admissao',
    solicitacaoId:     row.id,
    statusSolicitacao: row.status,
    rotaSugerida:      rotaSugeridaPorStatus(row.status),
    tokenProvisorio,
    candidato: {
      nome: row.prov_nome,
      cpf:  row.prov_cpf,
    },
    asoInfo: montarAsoInfo(row),
  });
}
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
              c.senha_temporaria, c.face_registrada,
              c.biometria_dispensada_em, c.biometria_dispensas_count,
              cg.nivel_acesso_id
       FROM people.colaboradores c
       LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
       WHERE c.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      const preAdmissao = await tentarLoginPreAdmissao(request, email, senha);
      if (preAdmissao) return preAdmissao;
      return errorResponse('Email ou senha inválidos', 401);
    }

    const user = result.rows[0];

    // Verificar se está ativo
    if (user.status !== 'ativo') {
      const preAdmissao = await tentarLoginPreAdmissao(request, email, senha);
      if (preAdmissao) return preAdmissao;
      return errorResponse('Usuário inativo', 401);
    }

    // Verificar senha
    const isValidPassword = await verifyPassword(senha, user.senha_hash);
    if (!isValidPassword) {
      const preAdmissao = await tentarLoginPreAdmissao(request, email, senha);
      if (preAdmissao) return preAdmissao;
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

    const senhaTemporaria = user.senha_temporaria === true;
    // Quando a senha ainda é temporária, segura o prompt de biometria —
    // o cliente força a troca de senha primeiro e só depois oferece face.
    const biometriaPrompt = senhaTemporaria
      ? { exibir: false, fase: null }
      : calcularBiometriaPrompt({
          faceRegistrada: user.face_registrada === true,
          dispensasCount: user.biometria_dispensas_count ?? 0,
          dispensadaEm: user.biometria_dispensada_em ?? null,
        });

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
        senhaTemporaria,
        biometriaPrompt,
      },
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return serverErrorResponse('Erro ao realizar login');
  }
}
