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
      const status = searchParams.get('status');
      const tipo = searchParams.get('tipo');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.LOCALIZACOES, { pagina, limite, status, tipo });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (status) {
          conditions.push(`status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM localizacoes ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados paginados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT * FROM localizacoes ${whereClause} ORDER BY nome LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          nome: row.nome,
          tipo: row.tipo,
          endereco: {
            cep: row.endereco_cep,
            logradouro: row.endereco_logradouro,
            numero: row.endereco_numero,
            complemento: row.endereco_complemento,
            bairro: row.endereco_bairro,
            cidade: row.endereco_cidade,
            estado: row.endereco_estado,
          },
          coordenadas: {
            latitude: parseFloat(row.latitude),
            longitude: parseFloat(row.longitude),
          },
          raioPermitido: row.raio_permitido,
          status: row.status,
        }));

        return buildPaginatedResponse(dados, total, pagina, limite);
      }, CACHE_TTL.MEDIUM);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar localizações:', error);
      return serverErrorResponse('Erro ao listar localizações');
    }
  });
}
