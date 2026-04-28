import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// GET /api/v1/niveis-acesso
// Lista os 3 níveis de acesso disponíveis (1, 2, 3) com nome e descrição.
// Usado pela UI para popular dropdowns de cargo e tela de gerenciamento
// de permissões por nível.
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const data = await cacheAside(
        `${CACHE_KEYS.PAPEL_PERMISSOES}niveis_lista`,
        async () => {
          const result = await query(
            `SELECT id, nome, descricao
             FROM people.niveis_acesso
             ORDER BY id ASC`
          );
          return result.rows.map((r) => ({
            id: r.id,
            nome: r.nome,
            descricao: r.descricao,
          }));
        },
        CACHE_TTL.LONG
      );

      return successResponse({ niveis: data });
    } catch (error) {
      console.error('Erro ao listar níveis de acesso:', error);
      return serverErrorResponse('Erro ao listar níveis de acesso');
    }
  });
}
