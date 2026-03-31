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
      const feriadoId = parseInt(id);

      if (isNaN(feriadoId)) {
        return notFoundResponse('Feriado não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.FERIADO}${feriadoId}`;

      const dados = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT * FROM feriados WHERE id = $1`,
          [feriadoId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        return {
          id: row.id,
          nome: row.nome,
          data: row.data,
          tipo: row.tipo,
          recorrente: row.recorrente,
          abrangencia: row.abrangencia,
          descricao: row.descricao,
        };
      }, CACHE_TTL.LONG);

      if (!dados) {
        return notFoundResponse('Feriado não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter feriado:', error);
      return serverErrorResponse('Erro ao obter feriado');
    }
  });
}
