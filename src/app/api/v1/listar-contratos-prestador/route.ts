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
      const { orderBy, orderDir } = getOrderParams(searchParams, ['numero', 'data_inicio', 'data_fim', 'valor', 'status', 'criado_em']);

      const prestadorId = searchParams.get('prestador_id');
      const status = searchParams.get('status');
      const busca = searchParams.get('busca');

      const cacheKey = buildListCacheKey(CACHE_KEYS.CONTRATOS_PRESTADOR, {
        pagina, limite, orderBy, orderDir, prestadorId, status, busca,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (prestadorId) {
          conditions.push(`c.prestador_id = $${paramIndex}`);
          params.push(parseInt(prestadorId));
          paramIndex++;
        }

        if (status) {
          conditions.push(`c.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (busca) {
          conditions.push(`(c.numero ILIKE $${paramIndex} OR c.descricao ILIKE $${paramIndex})`);
          params.push(`%${busca}%`);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) as total
           FROM bluepoint.bt_contratos_prestador c
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            c.id,
            c.prestador_id,
            p.nome_fantasia as prestador_nome,
            c.numero,
            c.descricao,
            c.data_inicio,
            c.data_fim,
            c.valor,
            c.forma_pagamento,
            c.status,
            c.alerta_renovacao_dias,
            c.observacoes,
            c.arquivo_url,
            c.criado_em,
            c.atualizado_em
          FROM bluepoint.bt_contratos_prestador c
          JOIN bluepoint.bt_prestadores p ON c.prestador_id = p.id
          ${whereClause}
          ORDER BY c.${orderBy} ${orderDir}
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          prestadorId: row.prestador_id,
          prestadorNome: row.prestador_nome,
          numero: row.numero,
          descricao: row.descricao,
          dataInicio: row.data_inicio,
          dataFim: row.data_fim,
          valor: parseFloat(row.valor),
          formaPagamento: row.forma_pagamento,
          status: row.status,
          alertaRenovacaoDias: row.alerta_renovacao_dias,
          observacoes: row.observacoes,
          arquivoUrl: row.arquivo_url,
          createdAt: row.criado_em,
          updatedAt: row.atualizado_em,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar contratos de prestador:', error);
      return serverErrorResponse('Erro ao listar contratos de prestador');
    }
  });
}
