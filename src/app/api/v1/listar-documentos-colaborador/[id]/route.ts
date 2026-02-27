import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.DOCUMENTOS}colaborador:${colaboradorId}`;

      const dados = await cacheAside(cacheKey, async () => {
        // Buscar documentos
        const result = await query(
          `SELECT id, tipo, nome, url, data_upload
           FROM bt_documentos_colaborador
           WHERE colaborador_id = $1
           ORDER BY data_upload DESC`,
          [colaboradorId]
        );

        const documentos = result.rows.map(doc => ({
          id: doc.id,
          tipo: doc.tipo,
          nome: doc.nome,
          url: doc.url,
          dataUpload: doc.data_upload,
        }));

        return { documentos };
      }, CACHE_TTL.MEDIUM);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar documentos:', error);
      return serverErrorResponse('Erro ao listar documentos');
    }
  });
}
