import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload, isSuperAdmin, resolveCargoFromColaborador } from '@/lib/auth';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { obterPermissoesEfetivasDoCargo } from '@/lib/permissoes-efetivas';

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
          cargoId: null,
          permissoes: todas.rows,
          codigos: todas.rows.map((r) => r.codigo),
        });
      }

      // Resolve cargo + nível: prioriza JWT; cai pro banco se faltar.
      let nivelId: number | null = typeof user.nivelId === 'number' ? user.nivelId : null;
      let cargoId: number | null = typeof user.cargoId === 'number' ? user.cargoId : null;
      if ((nivelId === null || cargoId === null) && user.userId > 0) {
        const r = await resolveCargoFromColaborador(user.userId);
        if (nivelId === null) nivelId = r.nivelId;
        if (cargoId === null) cargoId = r.cargoId;
      }

      const cacheKey = `${CACHE_KEYS.PAPEL_PERMISSOES}usuario:n${nivelId ?? 'null'}:c${cargoId ?? 'null'}:t${tipoUsuario}`;
      const data = await cacheAside(
        cacheKey,
        async () => {
          // Pega só os códigos efetivos (nível + overrides do cargo).
          const efetivas = await obterPermissoesEfetivasDoCargo({
            cargoId,
            nivelId,
            tipoLegado: tipoUsuario,
          });
          if (efetivas.codigos.length === 0) {
            return { permissoes: [], codigos: [] };
          }
          // E busca o detalhe (id, nome, modulo, acao) pra resposta.
          const result = await query(
            `SELECT id, codigo, nome, modulo, acao
               FROM people.permissoes
              WHERE codigo = ANY($1::text[])
              ORDER BY modulo, acao`,
            [efetivas.codigos],
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
        cargoId,
        ...data,
      });
    } catch (error) {
      console.error('Erro ao obter permissões do usuário:', error);
      return serverErrorResponse('Erro ao obter permissões do usuário');
    }
  });
}
