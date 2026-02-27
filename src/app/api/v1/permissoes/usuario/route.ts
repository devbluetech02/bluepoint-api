import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req: NextRequest, user: JWTPayload) => {
    try {
      const tipoUsuario = user.tipo;

      const data = await cacheAside(
        `${CACHE_KEYS.PAPEL_PERMISSOES}usuario:${tipoUsuario}`,
        async () => {
          const result = await query(
            `SELECT p.id, p.codigo, p.nome, p.modulo, p.acao
             FROM bt_tipo_usuario_permissoes tp
             JOIN bt_permissoes p ON tp.permissao_id = p.id
             WHERE tp.tipo_usuario = $1 AND tp.concedido = true
             ORDER BY p.modulo, p.acao`,
            [tipoUsuario]
          );

          return {
            permissoes: result.rows,
            codigos: result.rows.map((r) => r.codigo),
          };
        },
        CACHE_TTL.MEDIUM
      );

      return successResponse({
        userId: user.userId,
        tipo: tipoUsuario,
        ...data,
      });
    } catch (error) {
      console.error('Erro ao obter permissões do usuário:', error);
      return serverErrorResponse('Erro ao obter permissões do usuário');
    }
  });
}
