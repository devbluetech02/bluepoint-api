import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload, isSuperAdmin, resolveNivelFromColaborador } from '@/lib/auth';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req: NextRequest, user: JWTPayload) => {
    try {
      const tipoUsuario = user.tipo;

      // god mode — retorna o catálogo inteiro sem cache
      if (isSuperAdmin(user)) {
        const todas = await query(
          `SELECT id, codigo, nome, modulo, acao FROM people.permissoes
           ORDER BY modulo, acao`
        );
        return successResponse({
          userId: user.userId,
          tipo: tipoUsuario,
          nivelId: null,
          permissoes: todas.rows,
          codigos: todas.rows.map((r) => r.codigo),
        });
      }

      // Resolve o nível: prioriza o JWT; cai para o banco se ausente.
      let nivelId: number | null = null;
      if (typeof user.nivelId === 'number') {
        nivelId = user.nivelId;
      } else if (user.userId > 0) {
        nivelId = await resolveNivelFromColaborador(user.userId);
      }

      const cacheKey = `${CACHE_KEYS.PAPEL_PERMISSOES}usuario:n${nivelId ?? 'null'}:t${tipoUsuario}`;
      const data = await cacheAside(
        cacheKey,
        async () => {
          // União: permissões do nível + permissões do tipo legado.
          // Mantém compatibilidade com cargos ainda não reclassificados.
          const result = await query(
            `SELECT p.id, p.codigo, p.nome, p.modulo, p.acao
             FROM people.permissoes p
             WHERE p.id IN (
               SELECT permissao_id FROM people.nivel_acesso_permissoes
                 WHERE nivel_id = $1 AND concedido = true
               UNION
               SELECT permissao_id FROM people.tipo_usuario_permissoes
                 WHERE tipo_usuario = $2 AND concedido = true
             )
             ORDER BY p.modulo, p.acao`,
            [nivelId, tipoUsuario]
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
        nivelId,
        ...data,
      });
    } catch (error) {
      console.error('Erro ao obter permissões do usuário:', error);
      return serverErrorResponse('Erro ao obter permissões do usuário');
    }
  });
}
