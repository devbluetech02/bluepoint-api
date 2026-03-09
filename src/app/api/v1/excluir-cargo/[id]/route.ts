import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      // Verificar se existe
      const existeResult = await query(
        `SELECT id, nome FROM bluepoint.bt_cargos WHERE id = $1`,
        [cargoId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cargo = existeResult.rows[0];

      // Verificar se há colaboradores usando este cargo
      const colaboradoresResult = await query(
        `SELECT COUNT(*) as total FROM bluepoint.bt_colaboradores WHERE cargo_id = $1`,
        [cargoId]
      );

      if (parseInt(colaboradoresResult.rows[0].total) > 0) {
        return errorResponse('Não é possível excluir cargo com colaboradores vinculados', 400);
      }

      // Excluir
      await query(`DELETE FROM bluepoint.bt_cargos WHERE id = $1`, [cargoId]);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'cargos',
        descricao: `Cargo excluído: ${cargo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: cargoId, nome: cargo.nome },
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir cargo:', error);
      return serverErrorResponse('Erro ao excluir cargo');
    }
  });
}
