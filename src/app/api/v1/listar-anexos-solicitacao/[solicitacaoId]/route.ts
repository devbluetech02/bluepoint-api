import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ solicitacaoId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { solicitacaoId: id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      // Verificar se solicitação existe
      const solicitacaoResult = await query(
        `SELECT id FROM solicitacoes WHERE id = $1`,
        [solicitacaoId]
      );

      if (solicitacaoResult.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.ANEXOS}solicitacao:${solicitacaoId}`;

      const dados = await cacheAside(cacheKey, async () => {
        // Buscar anexos
        const result = await query(
          `SELECT id, nome, tipo, tamanho, url, data_upload
           FROM anexos
           WHERE solicitacao_id = $1
           ORDER BY data_upload`,
          [solicitacaoId]
        );

        const anexos = result.rows.map(row => ({
          id: row.id,
          nome: row.nome,
          tipo: row.tipo,
          tamanho: row.tamanho,
          url: row.url,
          dataUpload: row.data_upload,
        }));

        return { anexos };
      }, CACHE_TTL.MEDIUM);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar anexos:', error);
      return serverErrorResponse('Erro ao listar anexos');
    }
  });
}
