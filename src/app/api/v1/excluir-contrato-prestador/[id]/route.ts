import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateContratoPrestadorCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const contratoId = parseInt(id);

      if (isNaN(contratoId)) {
        return notFoundResponse('Contrato não encontrado');
      }

      const result = await query(
        `SELECT c.id, c.numero, c.prestador_id, c.status, p.nome_fantasia as prestador_nome
         FROM bluepoint.bt_contratos_prestador c
         JOIN bluepoint.bt_prestadores p ON c.prestador_id = p.id
         WHERE c.id = $1`,
        [contratoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Contrato não encontrado');
      }

      const contrato = result.rows[0];

      await query(
        `DELETE FROM bluepoint.bt_contratos_prestador WHERE id = $1`,
        [contratoId]
      );

      await invalidateContratoPrestadorCache(contratoId);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'excluir',
        modulo: 'contratos_prestador',
        descricao: `Contrato excluído: ${contrato.numero} de ${contrato.prestador_nome}`,
        entidadeId: contratoId,
        entidadeTipo: 'contrato_prestador',
        dadosAnteriores: {
          id: contratoId,
          numero: contrato.numero,
          prestadorId: contrato.prestador_id,
          prestadorNome: contrato.prestador_nome,
          status: contrato.status,
        },
      }));

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir contrato de prestador:', error);
      return serverErrorResponse('Erro ao excluir contrato de prestador');
    }
  });
}
