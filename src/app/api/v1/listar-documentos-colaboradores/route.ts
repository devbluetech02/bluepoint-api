import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import {
  getDocumentosColaboradorCacheado,
  DocumentosColaboradorResposta,
} from '@/lib/colaborador-documentos';

const MAX_IDS_POR_REQUISICAO = 200;

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const idsParam = searchParams.get('ids');

      if (!idsParam) {
        return errorResponse('Parâmetro "ids" é obrigatório (lista separada por vírgula)', 400);
      }

      const ids = Array.from(
        new Set(
          idsParam
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isInteger(n) && n > 0)
        )
      );

      if (ids.length === 0) {
        return successResponse({});
      }

      if (ids.length > MAX_IDS_POR_REQUISICAO) {
        return errorResponse(
          `Máximo de ${MAX_IDS_POR_REQUISICAO} IDs por requisição (recebido: ${ids.length})`,
          400
        );
      }

      // Carrega em paralelo. Cada chamada reaproveita o cache por colaborador
      // (mesma chave do endpoint single), então hits feitos antes não recustam.
      const resultados = await Promise.all(
        ids.map(async (id) => {
          try {
            const dados = await getDocumentosColaboradorCacheado(id);
            return { id, dados };
          } catch (err) {
            console.error(`[listar-documentos-colaboradores] erro id=${id}:`, err);
            return { id, dados: null };
          }
        })
      );

      const porColaborador: Record<string, DocumentosColaboradorResposta> = {};
      for (const { id, dados } of resultados) {
        if (dados != null) porColaborador[String(id)] = dados;
      }

      return successResponse(porColaborador);
    } catch (error) {
      console.error('Erro ao listar documentos em lote:', error);
      return serverErrorResponse('Erro ao listar documentos em lote');
    }
  });
}
