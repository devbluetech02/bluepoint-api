import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const busca = searchParams.get('busca');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.EMPRESAS, { pagina, limite, busca });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (busca) {
          conditions.push(`(nome_fantasia ILIKE $${paramIndex} OR razao_social ILIKE $${paramIndex} OR cnpj ILIKE $${paramIndex})`);
          params.push(`%${busca}%`);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM bluepoint.bt_empresas ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            id,
            razao_social,
            nome_fantasia,
            cnpj,
            celular,
            cep,
            estado,
            cidade,
            bairro,
            rua,
            numero,
            created_at,
            updated_at
          FROM bluepoint.bt_empresas
          ${whereClause}
          ORDER BY nome_fantasia ASC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          razaoSocial: row.razao_social,
          nomeFantasia: row.nome_fantasia,
          cnpj: row.cnpj,
          celular: row.celular,
          endereco: {
            cep: row.cep,
            estado: row.estado,
            cidade: row.cidade,
            bairro: row.bairro,
            rua: row.rua,
            numero: row.numero,
          },
          criadoEm: row.created_at,
          atualizadoEm: row.updated_at,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.MEDIUM);

      return successResponse(buildPaginatedResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite));
    } catch (error) {
      console.error('Erro ao listar empresas:', error);
      return serverErrorResponse('Erro ao listar empresas');
    }
  });
}
