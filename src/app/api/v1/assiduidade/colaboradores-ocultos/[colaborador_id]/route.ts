import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

interface Params {
  params: Promise<{ colaborador_id: string }>;
}

/**
 * DELETE /api/v1/assiduidade/colaboradores-ocultos/:colaborador_id
 * Remove o colaborador da lista de ocultos (volta a aparecer na assiduidade).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { colaborador_id: rawId } = await params;
      const colaboradorId = parseInt(rawId ?? '', 10);

      if (!colaboradorId || isNaN(colaboradorId)) {
        return errorResponse('colaborador_id inválido', 400);
      }

      const exist = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );
      if (exist.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      await query(
        `DELETE FROM people.assiduidade_colaboradores_ocultos WHERE colaborador_id = $1`,
        [colaboradorId]
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'assiduidade',
          descricao: `Colaborador exibido novamente na assiduidade: ${exist.rows[0].nome}`,
          colaboradorId,
          colaboradorNome: exist.rows[0].nome,
          entidadeId: colaboradorId,
          entidadeTipo: 'colaborador',
        })
      );

      return successResponse({
        colaborador_id: colaboradorId,
        mensagem: 'Colaborador exibido',
      });
    } catch (e) {
      console.error('Erro ao exibir colaborador (assiduidade):', e);
      return serverErrorResponse('Erro ao atualizar visibilidade do colaborador');
    }
  });
}
