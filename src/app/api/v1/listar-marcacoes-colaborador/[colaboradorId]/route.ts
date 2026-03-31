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

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = buildListCacheKey(CACHE_KEYS.MARCACOES, {
        tipo: 'colaborador', colaboradorId, pagina, limite, dataInicio, dataFim,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      // Construir filtros
      const conditions: string[] = ['m.colaborador_id = $1'];
      const params_query: unknown[] = [colaboradorId];
      let paramIndex = 2;

      if (dataInicio) {
        conditions.push(`m.data_hora >= $${paramIndex}`);
        params_query.push(dataInicio);
        paramIndex++;
      }

      if (dataFim) {
        conditions.push(`m.data_hora <= $${paramIndex}::date + interval '1 day'`);
        params_query.push(dataFim);
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total FROM people.marcacoes m ${whereClause}`,
        params_query
      );
      const total = parseInt(countResult.rows[0].total);

      // Buscar marcações
      const dataParams = [...params_query, limite, offset];
      const result = await query(
        `SELECT 
          m.id,
          m.data_hora,
          m.tipo,
          m.latitude,
          m.longitude,
          m.endereco,
          m.metodo,
          m.foto_url,
          m.observacao,
          m.foi_ajustada,
          m.data_hora_original,
          m.ajustada_em,
          aj.id as ajustada_por_id,
          aj.nome as ajustada_por_nome
        FROM people.marcacoes m
        LEFT JOIN people.colaboradores aj ON m.ajustada_por = aj.id
        ${whereClause}
        ORDER BY m.data_hora DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const dados = result.rows.map(row => ({
        id: row.id,
        dataHora: row.data_hora,
        tipo: row.tipo,
        localizacao: row.latitude ? {
          latitude: parseFloat(row.latitude),
          longitude: parseFloat(row.longitude),
          endereco: row.endereco,
        } : null,
        metodo: row.metodo,
        foto: row.foto_url,
        observacao: row.observacao,
        foiAjustada: row.foi_ajustada,
        ajuste: row.foi_ajustada ? {
          dataHoraOriginal: row.data_hora_original,
          ajustadaPor: row.ajustada_por_id ? { id: row.ajustada_por_id, nome: row.ajustada_por_nome } : null,
          ajustadaEm: row.ajustada_em,
        } : null,
      }));

      // Calcular resumo (apenas se período definido)
      let resumo = null;
      if (dataInicio && dataFim) {
        const resumoResult = await query(
          `SELECT 
            COUNT(DISTINCT DATE(data_hora)) as total_dias,
            COUNT(*) as total_marcacoes
          FROM people.marcacoes
          WHERE colaborador_id = $1 AND data_hora >= $2 AND data_hora <= $3::date + interval '1 day'`,
          [colaboradorId, dataInicio, dataFim]
        );

        resumo = {
          totalDias: parseInt(resumoResult.rows[0].total_dias),
          horasTrabalhadas: 0, // Calculado com base nas marcações
          horasExtras: 0,
          atrasos: 0,
        };
      }

      return { ...buildPaginatedResponse(dados, total, pagina, limite), resumo };
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar marcações do colaborador:', error);
      return serverErrorResponse('Erro ao listar marcações');
    }
  });
}
