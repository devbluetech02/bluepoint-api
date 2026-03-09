import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

/**
 * GET /api/v1/assiduidade/bloquear-colaborador
 * Lista colaboradores com bloqueado_assiduidade = true.
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const result = await query(
        `SELECT c.id, c.nome, c.email, c.cargo_id, cg.nome AS cargo_nome, c.bloqueado_assiduidade
         FROM bluepoint.bt_colaboradores c
         LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
         WHERE c.bloqueado_assiduidade = TRUE AND c.status = 'ativo'
         ORDER BY c.nome`
      );
      return successResponse({ bloqueados: result.rows });
    } catch (e) {
      console.error('Erro ao listar bloqueados:', e);
      return serverErrorResponse('Erro ao listar colaboradores bloqueados');
    }
  });
}

/**
 * POST /api/v1/assiduidade/bloquear-colaborador
 * Body: { colaborador_id: number, bloquear: boolean }
 * Atualiza bloqueado_assiduidade do colaborador.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json().catch(() => ({}));
      const colaboradorId = parseInt(body.colaborador_id ?? '', 10);
      const bloquear = !!body.bloquear;

      if (!colaboradorId || isNaN(colaboradorId)) {
        return errorResponse('colaborador_id obrigatório e numérico', 400);
      }

      const exist = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [colaboradorId]
      );
      if (exist.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      await query(
        `UPDATE bluepoint.bt_colaboradores SET bloqueado_assiduidade = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2`,
        [bloquear, colaboradorId]
      );

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'assiduidade',
        descricao: bloquear ? `Colaborador bloqueado para assiduidade` : `Colaborador desbloqueado para assiduidade`,
        colaboradorId,
        colaboradorNome: exist.rows[0].nome,
        entidadeId: colaboradorId,
        entidadeTipo: 'colaborador',
      }));

      return successResponse({
        colaborador_id: colaboradorId,
        bloqueado_assiduidade: bloquear,
        mensagem: bloquear ? 'Colaborador bloqueado para assiduidade' : 'Colaborador desbloqueado para assiduidade',
      });
    } catch (e) {
      console.error('Erro ao bloquear/desbloquear:', e);
      return serverErrorResponse('Erro ao atualizar bloqueio de assiduidade');
    }
  });
}
