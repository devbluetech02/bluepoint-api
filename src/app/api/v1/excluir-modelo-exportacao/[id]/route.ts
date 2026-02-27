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
      const modeloId = parseInt(id);

      if (isNaN(modeloId)) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const existeResult = await query(
        `SELECT id, nome, descricao FROM bluepoint.bt_modelos_exportacao WHERE id = $1`,
        [modeloId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const modelo = existeResult.rows[0];

      await query(
        `DELETE FROM bluepoint.bt_modelos_exportacao WHERE id = $1`,
        [modeloId]
      );

      await invalidateCache(CACHE_KEYS.MODELOS_EXPORTACAO);
      await invalidateCache(CACHE_KEYS.MODELO_EXPORTACAO, modeloId);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'exportacao',
        descricao: `Modelo de exportação excluído: ${modelo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: modelo.id, nome: modelo.nome, descricao: modelo.descricao },
      });

      return successResponse({ mensagem: 'Modelo de exportação excluído com sucesso.' });
    } catch (error) {
      console.error('Erro ao excluir modelo de exportação:', error);
      return serverErrorResponse('Erro ao excluir modelo de exportação');
    }
  });
}
