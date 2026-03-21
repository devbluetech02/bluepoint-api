import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

/**
 * GET /api/v1/tipos-documento-colaborador
 * Lista os tipos de documento (ASO, EPI, CNH, etc.) com validade e obrigatoriedade padrão.
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.DOCUMENTOS}tipos`;

      const tipos = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao
           FROM bluepoint.bt_tipos_documento_colaborador
           ORDER BY id ASC`
        );

        type TipoRow = { id: number; codigo: string; nome_exibicao: string; validade_meses: number | null; obrigatorio_padrao: boolean };
        return (result.rows as TipoRow[]).map((row) => ({
          id: row.id,
          codigo: row.codigo,
          nomeExibicao: row.nome_exibicao,
          validadeMeses: row.validade_meses,
          obrigatorioPadrao: row.obrigatorio_padrao,
        }));
      }, CACHE_TTL.LONG);

      return successResponse({ tipos });
    } catch (error) {
      console.error('Erro ao listar tipos de documento:', error);
      return serverErrorResponse('Erro ao listar tipos de documento');
    }
  });
}
