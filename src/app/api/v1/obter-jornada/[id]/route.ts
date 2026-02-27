import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const jornadaId = parseInt(id);

      if (isNaN(jornadaId)) {
        return notFoundResponse('Jornada não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.JORNADA}${jornadaId}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT * FROM bluepoint.bt_jornadas WHERE id = $1`,
        [jornadaId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const jornada = result.rows[0];

      // Buscar horários
      const horariosResult = await query(
        `SELECT dia_semana, sequencia, quantidade_dias, dias_semana, periodos, folga
         FROM bluepoint.bt_jornada_horarios
         WHERE jornada_id = $1
         ORDER BY sequencia NULLS LAST, dia_semana NULLS LAST`,
        [jornadaId]
      );

      // Contar colaboradores vinculados
      const colaboradoresResult = await query(
        `SELECT COUNT(*) as total FROM bluepoint.bt_colaboradores WHERE jornada_id = $1 AND status = 'ativo'`,
        [jornadaId]
      );

      const nomeDiasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

      return {
        id: jornada.id,
        nome: jornada.nome,
        descricao: jornada.descricao,
        tipo: jornada.tipo || 'simples',
        diasRepeticao: jornada.dias_repeticao,
        horarios: horariosResult.rows.map(h => ({
          diaSemana: h.dia_semana,
          diaSemanaTexto: h.dia_semana !== null ? nomeDiasSemana[h.dia_semana] : null,
          sequencia: h.sequencia,
          quantidadeDias: h.quantidade_dias || 1,
          diasSemana: h.dias_semana || [],
          diasSemanaTexto: (h.dias_semana || []).map((d: number) => nomeDiasSemana[d]),
          periodos: h.periodos || [],
          folga: h.folga || false,
        })),
        cargaHorariaSemanal: parseFloat(jornada.carga_horaria_semanal || 0),
        toleranciaEntrada: jornada.tolerancia_entrada,
        toleranciaSaida: jornada.tolerancia_saida,
        status: jornada.status,
        colaboradoresVinculados: parseInt(colaboradoresResult.rows[0].total),
      };
      }, CACHE_TTL.MEDIUM);

      if (!dados) {
        return notFoundResponse('Jornada não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter jornada:', error);
      return serverErrorResponse('Erro ao obter jornada');
    }
  });
}
