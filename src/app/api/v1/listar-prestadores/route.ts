import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, serverErrorResponse, getPaginationParams, getOrderParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const { orderBy, orderDir } = getOrderParams(searchParams, ['razao_social', 'nome_fantasia', 'cnpj_cpf', 'tipo', 'status', 'criado_em']);

      const busca = searchParams.get('busca');
      const status = searchParams.get('status');
      const tipo = searchParams.get('tipo');

      const cacheKey = buildListCacheKey(CACHE_KEYS.PRESTADORES, {
        pagina, limite, orderBy, orderDir, busca, status, tipo,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (busca) {
          conditions.push(`(p.razao_social ILIKE $${paramIndex} OR p.nome_fantasia ILIKE $${paramIndex} OR p.cnpj_cpf ILIKE $${paramIndex})`);
          params.push(`%${busca}%`);
          paramIndex++;
        }

        if (status) {
          conditions.push(`p.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`p.tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) as total FROM bluepoint.bt_prestadores p ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            p.id,
            p.razao_social,
            p.nome_fantasia,
            p.cnpj_cpf,
            p.tipo,
            p.email,
            p.telefone,
            p.endereco,
            p.area_atuacao,
            p.status,
            p.observacoes,
            p.criado_em,
            p.atualizado_em
          FROM bluepoint.bt_prestadores p
          ${whereClause}
          ORDER BY p.${orderBy} ${orderDir}
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          razaoSocial: row.razao_social,
          nomeFantasia: row.nome_fantasia,
          cnpjCpf: row.cnpj_cpf,
          tipo: row.tipo,
          email: row.email,
          telefone: row.telefone,
          endereco: row.endereco,
          areaAtuacao: row.area_atuacao,
          status: row.status,
          observacoes: row.observacoes,
          createdAt: row.criado_em,
          updatedAt: row.atualizado_em,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar prestadores:', error);
      return serverErrorResponse('Erro ao listar prestadores');
    }
  });
}
