import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAdmin(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const colaboradorId = searchParams.get('colaboradorId');
      const acao = searchParams.get('acao');
      const modulo = searchParams.get('modulo');

      const cacheKey = buildListCacheKey(CACHE_KEYS.LOGS_AUDITORIA, {
        pagina, limite, dataInicio, dataFim, colaboradorId, acao, modulo,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (dataInicio) {
        conditions.push(`a.data_hora >= $${paramIndex}`);
        params.push(dataInicio);
        paramIndex++;
      }

      if (dataFim) {
        conditions.push(`a.data_hora <= $${paramIndex}::date + interval '1 day'`);
        params.push(dataFim);
        paramIndex++;
      }

      if (colaboradorId) {
        conditions.push(`a.usuario_id = $${paramIndex}`);
        params.push(parseInt(colaboradorId));
        paramIndex++;
      }

      if (acao) {
        conditions.push(`a.acao = $${paramIndex}`);
        params.push(acao);
        paramIndex++;
      }

      if (modulo) {
        conditions.push(`a.modulo = $${paramIndex}`);
        params.push(modulo);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total FROM bt_auditoria a ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      // Buscar logs
      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT 
          a.id,
          a.data_hora,
          a.acao,
          a.modulo,
          a.descricao,
          a.ip,
          a.user_agent,
          a.dados_anteriores,
          a.dados_novos,
          c.id as usuario_id,
          c.nome as usuario_nome
        FROM bt_auditoria a
        LEFT JOIN bluepoint.bt_colaboradores c ON a.usuario_id = c.id
        ${whereClause}
        ORDER BY a.data_hora DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const dados = result.rows.map(row => ({
        id: row.id,
        dataHora: row.data_hora,
        usuario: row.usuario_id ? { id: row.usuario_id, nome: row.usuario_nome } : null,
        acao: row.acao,
        modulo: row.modulo,
        descricao: row.descricao,
        ip: row.ip,
        userAgent: row.user_agent,
        dadosAnteriores: row.dados_anteriores,
        dadosNovos: row.dados_novos,
      }));

      return buildPaginatedResponse(dados, total, pagina, limite);
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar logs de auditoria:', error);
      return serverErrorResponse('Erro ao listar logs');
    }
  });
}
