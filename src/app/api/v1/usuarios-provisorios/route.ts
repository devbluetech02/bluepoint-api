import { NextRequest, NextResponse } from 'next/server';
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

// Status terminais de falha: provisório pode ser reaproveitado.
const STATUS_TERMINAL_FALHA = new Set(['rejeitado', 'aso_reprovado']);

function conflictWithCode(message: string, code: string) {
  return NextResponse.json({ success: false, error: message, code }, { status: 409 });
}

// POST /api/v1/usuarios-provisorios — cria provisório ou reaproveita CPF de candidato rejeitado
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

      const { nome, cpf, empresaId, cargoId, departamentoId, jornadaId, diasTeste } = parsed.data;

      // Semântica: 0 dias é equivalente a "sem teste" → persiste como NULL.
      const diasTestePersist: number | null =
        diasTeste === undefined || diasTeste === null || diasTeste === 0 ? null : diasTeste;

      const cpfLimpo = cpf.replace(/\D/g, '');
      if (!isValidCPF(cpfLimpo)) {
        return errorResponse('CPF inválido', 400);
      }

      // 1. Verifica colaborador existente.
      const colaboradorResult = await query<{ id: number; status: string }>(
        `SELECT id, status FROM people.colaboradores WHERE cpf = $1`,
        [cpfLimpo]
      );
      const colaborador = colaboradorResult.rows[0] ?? null;
      if (colaborador?.status === 'ativo') {
        return conflictWithCode('Há um colaborador ativo com este CPF', 'colaborador_ativo');
      }
      // colaborador inativo (ou ausente) não bloqueia — segue pra criação/reaproveitamento.

      // 2. Verifica provisório existente + situação da solicitação mais recente.
      const provisorioExistente = await query<{ id: number; status_solicitacao: string | null }>(
        `SELECT up.id,
                (SELECT s.status
                   FROM people.solicitacoes_admissao s
                  WHERE s.usuario_provisorio_id = up.id
                  ORDER BY s.criado_em DESC
                  LIMIT 1) AS status_solicitacao
           FROM people.usuarios_provisorios up
          WHERE up.cpf = $1`,
        [cpfLimpo]
      );
      const provisorio = provisorioExistente.rows[0] ?? null;
      const podeReaproveitar = provisorio != null &&
        provisorio.status_solicitacao != null &&
        STATUS_TERMINAL_FALHA.has(provisorio.status_solicitacao);

      if (provisorio != null && !podeReaproveitar) {
        return conflictWithCode(
          'Há um processo de admissão em andamento para este CPF',
          'processo_em_andamento'
        );
      }

      // 3. Valida FKs de vínculo (empresa, cargo, departamento, jornada).
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

      // 4. Busca formulário ativo — usado na nova solicitação.
      const formResult = await query<{ id: string }>(
        `SELECT id FROM people.formularios_admissao
         WHERE ativo = true
         ORDER BY atualizado_em DESC
         LIMIT 1`,
        []
      );
      if (formResult.rows.length === 0) {
        return serverErrorResponse('Nenhum formulário de admissão ativo');
      }
      const formularioId = formResult.rows[0].id;

      // 5. Transação: cria/reaproveita provisório + cria nova solicitação 'nao_acessado'.
      await query('BEGIN', []);

      let provRow: Record<string, unknown>;
      let solicitacaoId: string;
      let reutilizado = false;
      try {
        if (podeReaproveitar && provisorio) {
          reutilizado = true;
          const upd = await query(
            `UPDATE people.usuarios_provisorios
                SET nome            = $1,
                    empresa_id      = $2,
                    cargo_id        = $3,
                    departamento_id = $4,
                    jornada_id      = $5,
                    dias_teste      = $6,
                    status          = 'ativo',
                    atualizado_em   = NOW()
              WHERE id = $7
            RETURNING id, nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, dias_teste, status, criado_em`,
            [nome, empresaId, cargoId, departamentoId, jornadaId, diasTestePersist, provisorio.id]
          );
          provRow = upd.rows[0];
        } else {
          const insProv = await query(
            `INSERT INTO people.usuarios_provisorios
               (nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, dias_teste, criado_por)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, dias_teste, status, criado_em`,
            [nome, cpfLimpo, empresaId, cargoId, departamentoId, jornadaId, diasTestePersist, user.userId]
          );
          provRow = insProv.rows[0];
        }

        const solResult = await query<{ id: string }>(
          `INSERT INTO people.solicitacoes_admissao
             (formulario_id, status, dados, usuario_provisorio_id)
           VALUES ($1, 'nao_acessado', '{}'::jsonb, $2)
           RETURNING id`,
          [formularioId, provRow.id]
        );
        solicitacaoId = solResult.rows[0].id;

        await query('COMMIT', []);
      } catch (txErr) {
        await query('ROLLBACK', []);
        throw txErr;
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: reutilizado ? 'editar' : 'criar',
        modulo: 'usuarios_provisorios',
        descricao: reutilizado
          ? `Provisório reaproveitado após rejeição anterior: ${nome} (CPF: ${cpfLimpo})`
          : `Usuário provisório criado: ${nome} (CPF: ${cpfLimpo})`,
        colaboradorId: provRow.id as number,
        colaboradorNome: nome,
        dadosNovos: { solicitacaoId, reutilizado, readmissaoExColaborador: colaborador?.status === 'inativo' },
      }));

      const payload = {
        id:             provRow.id,
        nome:           provRow.nome,
        cpf:            provRow.cpf,
        empresaId:      provRow.empresa_id,
        cargoId:        provRow.cargo_id,
        departamentoId: provRow.departamento_id,
        jornadaId:      provRow.jornada_id,
        diasTeste:      (provRow.dias_teste as number | null) ?? null,
        status:         provRow.status,
        criadoEm:       provRow.criado_em,
        solicitacaoId,
        reutilizado,
        readmissao:     colaborador?.status === 'inativo',
      };

      // Reaproveitamento usa 200 (não é recurso novo); criação usa 201.
      return reutilizado ? successResponse(payload) : createdResponse(payload);
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
                up.dias_teste,
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
          diasTeste:    r.dias_teste ?? null,
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
