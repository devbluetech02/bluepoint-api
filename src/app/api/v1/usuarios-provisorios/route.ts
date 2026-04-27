import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { successResponse, createdResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { criarUsuarioProvisorioSchema } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { criarOuReaproveitarProvisorio } from '@/lib/usuarios-provisorios';

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

      await query('BEGIN', []);
      let resultado: Awaited<ReturnType<typeof criarOuReaproveitarProvisorio>>;
      try {
        resultado = await criarOuReaproveitarProvisorio(
          { nome, cpf, empresaId, cargoId, departamentoId, jornadaId, diasTeste },
          user.userId
        );
        if (!resultado.ok) {
          await query('ROLLBACK', []);
        } else {
          await query('COMMIT', []);
        }
      } catch (txErr) {
        await query('ROLLBACK', []);
        throw txErr;
      }

      if (!resultado.ok) {
        const erro = resultado.erro;
        switch (erro.code) {
          case 'cpf_invalido':
            return errorResponse('CPF inválido', 400);
          case 'colaborador_ativo':
            return conflictWithCode('Há um colaborador ativo com este CPF', 'colaborador_ativo');
          case 'processo_em_andamento':
            return conflictWithCode(
              'Há um processo de admissão em andamento para este CPF',
              'processo_em_andamento'
            );
          case 'fk_invalida':
            return errorResponse(`${erro.campo} não encontrada: ${erro.id}`, 400);
          case 'sem_formulario_ativo':
            return serverErrorResponse('Nenhum formulário de admissão ativo');
        }
      }

      const { provRow, solicitacaoId, reutilizado, readmissao } = resultado.data;
      const cpfLimpo = provRow.cpf;

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: reutilizado ? 'editar' : 'criar',
        modulo: 'usuarios_provisorios',
        descricao: reutilizado
          ? `Provisório reaproveitado após rejeição anterior: ${nome} (CPF: ${cpfLimpo})`
          : `Usuário provisório criado: ${nome} (CPF: ${cpfLimpo})`,
        colaboradorId: provRow.id,
        colaboradorNome: nome,
        dadosNovos: { solicitacaoId, reutilizado, readmissaoExColaborador: readmissao },
      }));

      const payload = {
        id:             provRow.id,
        nome:           provRow.nome,
        cpf:            provRow.cpf,
        empresaId:      provRow.empresa_id,
        cargoId:        provRow.cargo_id,
        departamentoId: provRow.departamento_id,
        jornadaId:      provRow.jornada_id,
        diasTeste:      provRow.dias_teste ?? null,
        status:         provRow.status,
        criadoEm:       provRow.criado_em,
        solicitacaoId,
        reutilizado,
        readmissao,
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
