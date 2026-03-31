import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const notificacaoId = parseInt(id);

      if (isNaN(notificacaoId)) {
        return notFoundResponse('Notificação não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.NOTIFICACAO}${notificacaoId}:${user.userId}`;

      const dados = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT * FROM notificacoes WHERE id = $1 AND usuario_id = $2`,
          [notificacaoId, user.userId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        return {
          id: row.id,
          tipo: row.tipo,
          titulo: row.titulo,
          mensagem: row.mensagem,
          lida: row.lida,
          dataEnvio: row.data_envio,
          dataLeitura: row.data_leitura,
          link: row.link,
          metadados: row.metadados,
        };
      }, CACHE_TTL.SHORT);

      if (!dados) {
        return notFoundResponse('Notificação não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter notificação:', error);
      return serverErrorResponse('Erro ao obter notificação');
    }
  });
}
