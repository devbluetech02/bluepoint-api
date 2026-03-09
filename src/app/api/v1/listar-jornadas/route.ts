import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const status = searchParams.get('status');

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.JORNADAS, { pagina, limite, status });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = ['j.excluido_em IS NULL']; // Não mostrar excluídos
        const params: unknown[] = [];
        let paramIndex = 1;

        if (status) {
          conditions.push(`j.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM bluepoint.bt_jornadas j ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar jornadas
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT j.* FROM bluepoint.bt_jornadas j
           ${whereClause}
           ORDER BY j.nome ASC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        // Buscar horários de todas as jornadas de uma vez (evita N+1)
        const jornadaIds = result.rows.map(j => j.id);
        const horariosResult = jornadaIds.length > 0 ? await query(
          `SELECT jornada_id, dia_semana, sequencia, quantidade_dias, dias_semana, periodos, folga
           FROM bluepoint.bt_jornada_horarios
           WHERE jornada_id = ANY($1)
           ORDER BY jornada_id, sequencia NULLS LAST, dia_semana NULLS LAST`,
          [jornadaIds]
        ) : { rows: [] };

        // Agrupar horários por jornada_id
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const horariosMap = new Map<number, any[]>();
        for (const h of horariosResult.rows) {
          if (!horariosMap.has(h.jornada_id)) horariosMap.set(h.jornada_id, []);
          horariosMap.get(h.jornada_id)!.push(h);
        }

        const dados = result.rows.map(jornada => ({
          id: jornada.id,
          nome: jornada.nome,
          descricao: jornada.descricao,
          tipo: jornada.tipo || 'simples',
          diasRepeticao: jornada.dias_repeticao,
          horarios: (horariosMap.get(jornada.id) || []).map(h => ({
            diaSemana: h.dia_semana,
            sequencia: h.sequencia,
            quantidadeDias: h.quantidade_dias || 1,
            diasSemana: h.dias_semana || [],
            periodos: h.periodos || [],
            folga: h.folga || false,
          })),
          cargaHorariaSemanal: parseFloat(jornada.carga_horaria_semanal || 0),
          toleranciaEntrada: jornada.tolerancia_entrada,
          toleranciaSaida: jornada.tolerancia_saida,
          status: jornada.status,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.MEDIUM);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar jornadas:', error);
      return serverErrorResponse('Erro ao listar jornadas');
    }
  });
}
