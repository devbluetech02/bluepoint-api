import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const codigoId = parseInt(id);

      if (isNaN(codigoId)) {
        return notFoundResponse('Código de exportação não encontrado');
      }

      const existeResult = await query(
        `SELECT id, modelo_id, codigo, descricao
         FROM bluepoint.bt_codigos_exportacao WHERE id = $1`,
        [codigoId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Código de exportação não encontrado');
      }

      const codigoExportacao = existeResult.rows[0];

      await query(
        `DELETE FROM bluepoint.bt_codigos_exportacao WHERE id = $1`,
        [codigoId]
      );

      await invalidateCache(CACHE_KEYS.MODELO_EXPORTACAO, codigoExportacao.modelo_id);
      await invalidateCache(CACHE_KEYS.MODELOS_EXPORTACAO);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'exportacao',
        descricao: `Código de exportação excluído: ${codigoExportacao.codigo}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: {
          id: codigoExportacao.id,
          modeloId: codigoExportacao.modelo_id,
          codigo: codigoExportacao.codigo,
        },
      });

      return successResponse({ mensagem: 'Código de exportação excluído com sucesso.' });
    } catch (error) {
      console.error('Erro ao excluir código de exportação:', error);
      return serverErrorResponse('Erro ao excluir código de exportação');
    }
  });
}
