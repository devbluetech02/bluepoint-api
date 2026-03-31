import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.TIPOS_SOLICITACAO}all`;

      const dados = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT codigo, nome, descricao, requer_anexo, campos_adicionais
           FROM tipos_solicitacao
           WHERE ativo = true
           ORDER BY nome`
        );

        const tipos = result.rows.map(row => ({
          codigo: row.codigo,
          nome: row.nome,
          descricao: row.descricao,
          requerAnexo: row.requer_anexo,
          camposAdicionais: row.campos_adicionais,
        }));

        return { tipos };
      }, CACHE_TTL.LONG);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar tipos de solicitação:', error);
      return serverErrorResponse('Erro ao listar tipos');
    }
  });
}
