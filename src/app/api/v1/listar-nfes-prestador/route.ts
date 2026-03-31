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
      const { orderBy, orderDir } = getOrderParams(searchParams, ['numero', 'data_emissao', 'valor', 'status', 'criado_em']);

      const prestadorId = searchParams.get('prestador_id');
      const contratoId = searchParams.get('contrato_id');
      const status = searchParams.get('status');
      const busca = searchParams.get('busca');

      const cacheKey = buildListCacheKey(CACHE_KEYS.NFES_PRESTADOR, {
        pagina, limite, orderBy, orderDir, prestadorId, contratoId, status, busca,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (prestadorId) {
          conditions.push(`n.prestador_id = $${paramIndex}`);
          params.push(parseInt(prestadorId));
          paramIndex++;
        }

        if (contratoId) {
          conditions.push(`n.contrato_id = $${paramIndex}`);
          params.push(parseInt(contratoId));
          paramIndex++;
        }

        if (status) {
          conditions.push(`n.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (busca) {
          conditions.push(`(n.numero ILIKE $${paramIndex} OR n.chave_acesso ILIKE $${paramIndex})`);
          params.push(`%${busca}%`);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) as total
           FROM people.nfes_prestador n
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            n.id,
            n.prestador_id,
            p.nome_fantasia as prestador_nome,
            n.contrato_id,
            c.numero as contrato_numero,
            n.numero,
            n.serie,
            n.chave_acesso,
            n.data_emissao,
            n.valor,
            n.status,
            n.arquivo_url,
            n.observacoes,
            n.criado_em,
            n.atualizado_em
          FROM people.nfes_prestador n
          JOIN people.prestadores p ON n.prestador_id = p.id
          LEFT JOIN people.contratos_prestador c ON n.contrato_id = c.id
          ${whereClause}
          ORDER BY n.${orderBy} ${orderDir}
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          prestadorId: row.prestador_id,
          prestadorNome: row.prestador_nome,
          contratoId: row.contrato_id,
          contratoNumero: row.contrato_numero,
          numero: row.numero,
          serie: row.serie,
          chaveAcesso: row.chave_acesso,
          dataEmissao: row.data_emissao,
          valor: parseFloat(row.valor),
          status: row.status,
          arquivoUrl: row.arquivo_url,
          observacoes: row.observacoes,
          createdAt: row.criado_em,
          updatedAt: row.atualizado_em,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar NFes de prestador:', error);
      return serverErrorResponse('Erro ao listar NFes de prestador');
    }
  });
}
