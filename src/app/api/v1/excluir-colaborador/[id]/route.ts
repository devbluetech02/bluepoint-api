import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateColaboradorCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Buscar colaborador
      const result = await query(
        `SELECT id, nome, email FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = result.rows[0];

      // Soft delete - apenas marcar como inativo
      await query(
        `UPDATE people.colaboradores SET status = 'inativo', atualizado_em = NOW() WHERE id = $1`,
        [colaboradorId]
      );

      // Invalidar cache
      await invalidateColaboradorCache(colaboradorId);

      // Registrar auditoria
      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'excluir',
        modulo: 'colaboradores',
        descricao: `Colaborador excluído: ${colaborador.nome}`,
        colaboradorId,
        colaboradorNome: colaborador.nome,
        entidadeId: colaboradorId,
        entidadeTipo: 'colaborador',
        dadosAnteriores: { id: colaboradorId, nome: colaborador.nome, email: colaborador.email },
      }));

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir colaborador:', error);
      return serverErrorResponse('Erro ao excluir colaborador');
    }
  });
}
