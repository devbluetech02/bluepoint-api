import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidatePrestadorCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const prestadorId = parseInt(id);

      if (isNaN(prestadorId)) {
        return notFoundResponse('Prestador não encontrado');
      }

      const result = await query(
        `SELECT id, razao_social, cnpj_cpf, tipo, status
         FROM bluepoint.bt_prestadores WHERE id = $1`,
        [prestadorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Prestador não encontrado');
      }

      const prestador = result.rows[0];

      await query(
        `DELETE FROM bluepoint.bt_prestadores WHERE id = $1`,
        [prestadorId]
      );

      await invalidatePrestadorCache(prestadorId);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'excluir',
        modulo: 'prestadores',
        descricao: `Prestador excluído: ${prestador.razao_social}`,
        entidadeId: prestadorId,
        entidadeTipo: 'prestador',
        dadosAnteriores: {
          id: prestadorId,
          razaoSocial: prestador.razao_social,
          cnpjCpf: prestador.cnpj_cpf,
          tipo: prestador.tipo,
          status: prestador.status,
        },
      }));

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir prestador:', error);
      return serverErrorResponse('Erro ao excluir prestador');
    }
  });
}
