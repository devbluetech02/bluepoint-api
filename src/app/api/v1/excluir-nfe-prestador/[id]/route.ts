import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateNfePrestadorCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const nfeId = parseInt(id);

      if (isNaN(nfeId)) {
        return notFoundResponse('NFe não encontrada');
      }

      const result = await query(
        `SELECT n.id, n.numero, n.prestador_id, n.valor, n.status, p.nome_fantasia as prestador_nome
         FROM bluepoint.bt_nfes_prestador n
         JOIN bluepoint.bt_prestadores p ON n.prestador_id = p.id
         WHERE n.id = $1`,
        [nfeId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('NFe não encontrada');
      }

      const nfe = result.rows[0];

      await query(
        `DELETE FROM bluepoint.bt_nfes_prestador WHERE id = $1`,
        [nfeId]
      );

      await invalidateNfePrestadorCache(nfeId);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'excluir',
        modulo: 'nfes_prestador',
        descricao: `NFe excluída: ${nfe.numero} de ${nfe.prestador_nome}`,
        entidadeId: nfeId,
        entidadeTipo: 'nfe_prestador',
        dadosAnteriores: {
          id: nfeId,
          numero: nfe.numero,
          prestadorId: nfe.prestador_id,
          prestadorNome: nfe.prestador_nome,
          valor: nfe.valor,
          status: nfe.status,
        },
      }));

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir NFe de prestador:', error);
      return serverErrorResponse('Erro ao excluir NFe de prestador');
    }
  });
}
