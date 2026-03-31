import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req) => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const tipo = searchParams.get('tipo');

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = buildListCacheKey(CACHE_KEYS.HISTORICO_HORAS, {
        colaboradorId, pagina, limite, dataInicio, dataFim, tipo,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      // Construir filtros
      const conditions: string[] = ['colaborador_id = $1'];
      const params_query: unknown[] = [colaboradorId];
      let paramIndex = 2;

      if (dataInicio) {
        conditions.push(`data >= $${paramIndex}`);
        params_query.push(dataInicio);
        paramIndex++;
      }

      if (dataFim) {
        conditions.push(`data <= $${paramIndex}`);
        params_query.push(dataFim);
        paramIndex++;
      }

      if (tipo) {
        conditions.push(`tipo = $${paramIndex}`);
        params_query.push(tipo);
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total FROM banco_horas ${whereClause}`,
        params_query
      );
      const total = parseInt(countResult.rows[0].total);

      // Buscar histórico
      const dataParams = [...params_query, limite, offset];
      const result = await query(
        `SELECT id, data, tipo, descricao, horas, saldo_anterior, saldo_atual, observacao, criado_em
         FROM banco_horas
         ${whereClause}
         ORDER BY criado_em DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const dados = result.rows.map(row => ({
        id: row.id,
        data: row.data,
        tipo: row.tipo,
        descricao: row.descricao,
        horas: parseFloat(row.horas),
        saldoAnterior: parseFloat(row.saldo_anterior),
        saldoAtual: parseFloat(row.saldo_atual),
        observacao: row.observacao,
      }));

      return buildPaginatedResponse(dados, total, pagina, limite);
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar histórico de horas:', error);
      return serverErrorResponse('Erro ao listar histórico');
    }
  });
}
