import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const lida = searchParams.get('lida');
      const tipo = searchParams.get('tipo');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.NOTIFICACOES, {
        userId: user.userId, pagina, limite, lida, tipo,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = ['usuario_id = $1'];
        const params: unknown[] = [user.userId];
        let paramIndex = 2;

        if (lida !== null) {
          conditions.push(`lida = $${paramIndex}`);
          params.push(lida === 'true');
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM notificacoes ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Contar não lidas
        const naoLidasResult = await query(
          `SELECT COUNT(*) as total FROM notificacoes WHERE usuario_id = $1 AND lida = false`,
          [user.userId]
        );
        const naoLidas = parseInt(naoLidasResult.rows[0].total);

        // Buscar notificações
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT id, tipo, titulo, mensagem, lida, data_envio, link, metadados
           FROM notificacoes
           ${whereClause}
           ORDER BY data_envio DESC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          tipo: row.tipo,
          titulo: row.titulo,
          mensagem: row.mensagem,
          lida: row.lida,
          dataEnvio: row.data_envio,
          link: row.link,
          metadados: row.metadados,
        }));

        return { dados, total, pagina, limite, naoLidas };
      }, CACHE_TTL.SHORT);

      return successResponse({
        ...buildPaginatedResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite),
        naoLidas: resultado.naoLidas,
      });
    } catch (error) {
      console.error('Erro ao listar notificações:', error);
      return serverErrorResponse('Erro ao listar notificações');
    }
  });
}
