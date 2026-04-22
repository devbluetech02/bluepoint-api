import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { successResponse, createdResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { criarUsuarioProvisorioSchema } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { isValidCPF } from '@/lib/utils';

type VinculoChave = 'empresaId' | 'cargoId' | 'departamentoId' | 'jornadaId';

const VINCULOS: { campo: VinculoChave; tabela: string; label: string }[] = [
  { campo: 'empresaId',      tabela: 'empresas',      label: 'Empresa' },
  { campo: 'cargoId',        tabela: 'cargos',        label: 'Cargo' },
  { campo: 'departamentoId', tabela: 'departamentos', label: 'Departamento' },
  { campo: 'jornadaId',      tabela: 'jornadas',      label: 'Jornada' },
];

// POST /api/v1/usuarios-provisorios — cria um usuário provisório
export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const parsed = criarUsuarioProvisorioSchema.safeParse(body);
      if (!parsed.success) {
        const primeira = parsed.error.issues[0];
        const campo = primeira.path.join('.') || 'body';
        const ausente = primeira.code === 'invalid_type' && /received undefined/.test(primeira.message);
        const msg = ausente ? `${campo} é obrigatório` : `${campo}: ${primeira.message}`;
        return errorResponse(msg, 400);
      }

      const { nome, cpf, empresaId, cargoId, departamentoId, jornadaId } = parsed.data;

      const cpfLimpo = cpf.replace(/\D/g, '');
      if (!isValidCPF(cpfLimpo)) {
        return errorResponse('CPF inválido', 400);
      }

      const existente = await query(
        `SELECT id FROM people.usuarios_provisorios WHERE cpf = $1`,
        [cpfLimpo]
      );
      if (existente.rows.length > 0) {
        return errorResponse('CPF já cadastrado como usuário provisório', 409);
      }

      const colaboradorExistente = await query(
        `SELECT id FROM people.colaboradores WHERE cpf = $1`,
        [cpfLimpo]
      );
      if (colaboradorExistente.rows.length > 0) {
        return errorResponse('CPF já cadastrado como colaborador', 409);
      }

      const valoresPorCampo: Record<VinculoChave, number> = {
        empresaId, cargoId, departamentoId, jornadaId,
      };
      for (const v of VINCULOS) {
        const id = valoresPorCampo[v.campo];
        const check = await query(
          `SELECT 1 FROM people.${v.tabela} WHERE id = $1`,
          [id]
        );
        if (check.rows.length === 0) {
          return errorResponse(`${v.label} não encontrada: ${id}`, 400);
        }
      }

      // Cria provisório + stub de solicitacao_admissao ('nao_acessado') atomicamente.
      // Se o INSERT da solicitacao falhar, faz rollback do provisório.
      await query('BEGIN', []);

      let criado: Record<string, unknown>;
      let solicitacaoId: string;
      try {
        const provResult = await query(
          `INSERT INTO people.usuarios_provisorios
             (nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, criado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, status, criado_em`,
          [nome, cpfLimpo, empresaId, cargoId, departamentoId, jornadaId, user.userId]
        );
        criado = provResult.rows[0];

        const formResult = await query(
          `SELECT id FROM people.formularios_admissao
           WHERE ativo = true
           ORDER BY atualizado_em DESC
           LIMIT 1`,
          []
        );
        if (formResult.rows.length === 0) {
          throw new Error('Nenhum formulário de admissão ativo — stub não pode ser criado');
        }
        const formularioId = formResult.rows[0].id as string;

        const solResult = await query(
          `INSERT INTO people.solicitacoes_admissao
             (formulario_id, status, dados, usuario_provisorio_id)
           VALUES ($1, 'nao_acessado', '{}'::jsonb, $2)
           RETURNING id`,
          [formularioId, criado.id]
        );
        solicitacaoId = solResult.rows[0].id as string;

        await query('COMMIT', []);
      } catch (txErr) {
        await query('ROLLBACK', []);
        throw txErr;
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'criar',
        modulo: 'usuarios_provisorios',
        descricao: `Usuário provisório criado: ${nome} (CPF: ${cpfLimpo})`,
        colaboradorId: criado.id as number,
        colaboradorNome: nome,
        dadosNovos: { solicitacaoId },
      }));

      return createdResponse({
        id:             criado.id,
        nome:           criado.nome,
        cpf:            criado.cpf,
        empresaId:      criado.empresa_id,
        cargoId:        criado.cargo_id,
        departamentoId: criado.departamento_id,
        jornadaId:      criado.jornada_id,
        status:         criado.status,
        criadoEm:       criado.criado_em,
        solicitacaoId,
      });
    } catch (error) {
      console.error('Erro ao criar usuário provisório:', error);
      return serverErrorResponse('Erro ao criar usuário provisório');
    }
  });
}

// GET /api/v1/usuarios-provisorios — lista usuários provisórios
export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const status = searchParams.get('status') ?? 'ativo';

      const result = await query(
        `SELECT up.id, up.nome, up.cpf, up.status, up.expira_em, up.observacao, up.criado_em,
                up.empresa_id,      e.nome_fantasia AS empresa_nome,
                up.cargo_id,        c.nome AS cargo_nome,
                up.departamento_id, d.nome AS departamento_nome,
                up.jornada_id,      j.nome AS jornada_nome
           FROM people.usuarios_provisorios up
           LEFT JOIN people.empresas      e ON e.id = up.empresa_id
           LEFT JOIN people.cargos        c ON c.id = up.cargo_id
           LEFT JOIN people.departamentos d ON d.id = up.departamento_id
           LEFT JOIN people.jornadas      j ON j.id = up.jornada_id
          WHERE up.status = $1
          ORDER BY up.criado_em DESC`,
        [status]
      );

      return successResponse(
        result.rows.map((r) => ({
          id:           r.id,
          nome:         r.nome,
          cpf:          r.cpf,
          status:       r.status,
          expiraEm:     r.expira_em,
          observacao:   r.observacao,
          criadoEm:     r.criado_em,
          empresa:      r.empresa_id      ? { id: r.empresa_id,      nome: r.empresa_nome      } : null,
          cargo:        r.cargo_id        ? { id: r.cargo_id,        nome: r.cargo_nome        } : null,
          departamento: r.departamento_id ? { id: r.departamento_id, nome: r.departamento_nome } : null,
          jornada:      r.jornada_id      ? { id: r.jornada_id,      nome: r.jornada_nome      } : null,
          jornadaId:    r.jornada_id,
        }))
      );
    } catch (error) {
      console.error('Erro ao listar usuários provisórios:', error);
      return serverErrorResponse('Erro ao listar usuários provisórios');
    }
  });
}
