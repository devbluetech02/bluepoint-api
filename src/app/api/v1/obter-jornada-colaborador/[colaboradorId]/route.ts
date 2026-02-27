import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getDayName, calcularCargaHoraria } from '@/lib/utils';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.JORNADA}colaborador:${colaboradorId}`;

      const dados = await cacheAside(cacheKey, async () => {
      const result = await query(
        `SELECT 
          c.id as colaborador_id,
          c.nome as colaborador_nome,
          c.email as colaborador_email,
          j.id as jornada_id,
          j.nome as jornada_nome,
          j.descricao as jornada_descricao,
          j.carga_horaria_semanal,
          j.tolerancia_entrada,
          j.tolerancia_saida
        FROM bluepoint.bt_colaboradores c
        LEFT JOIN bt_jornadas j ON c.jornada_id = j.id
        WHERE c.id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      if (!row.jornada_id) {
        return {
          colaborador: {
            id: row.colaborador_id,
            nome: row.colaborador_nome,
            email: row.colaborador_email,
          },
          jornada: null,
          horarioHoje: null,
        };
      }

      // Buscar todos os horários da jornada
      const horariosResult = await query(
        `SELECT dia_semana, sequencia, quantidade_dias, dias_semana, periodos, folga
         FROM bluepoint.bt_jornada_horarios
         WHERE jornada_id = $1
         ORDER BY sequencia NULLS LAST, dia_semana NULLS LAST`,
        [row.jornada_id]
      );

      // Buscar horário de hoje
      const hoje = new Date();
      const diaSemana = hoje.getDay();

      // Para jornada simples: busca pelo dia_semana
      // Para jornada circular: busca pelo dias_semana que contenha o dia atual
      const horarioHojeResult = await query(
        `SELECT * FROM bluepoint.bt_jornada_horarios
         WHERE jornada_id = $1 
         AND (dia_semana = $2 OR dias_semana @> $3::jsonb)`,
        [row.jornada_id, diaSemana, JSON.stringify([diaSemana])]
      );

      let horarioHoje = null;
      if (horarioHojeResult.rows.length > 0) {
        const h = horarioHojeResult.rows[0];
        horarioHoje = {
          diaSemana: h.dia_semana,
          diaSemanaTexto: h.dia_semana !== null ? getDayName(h.dia_semana) : null,
          diasSemana: h.dias_semana || [],
          periodos: h.periodos || [],
          folga: h.folga || false,
          cargaHoraria: calcularCargaHoraria(h.periodos || [], h.folga),
        };
      }

      return {
        colaborador: {
          id: row.colaborador_id,
          nome: row.colaborador_nome,
          email: row.colaborador_email,
        },
        jornada: {
          id: row.jornada_id,
          nome: row.jornada_nome,
          descricao: row.jornada_descricao,
          cargaHorariaSemanal: parseFloat(row.carga_horaria_semanal),
          toleranciaEntrada: row.tolerancia_entrada,
          toleranciaSaida: row.tolerancia_saida,
          horarios: horariosResult.rows.map(h => ({
            diaSemana: h.dia_semana,
            diaSemanaTexto: h.dia_semana !== null ? getDayName(h.dia_semana) : null,
            sequencia: h.sequencia,
            quantidadeDias: h.quantidade_dias || 1,
            diasSemana: h.dias_semana || [],
            diasSemanaTexto: (h.dias_semana || []).map((d: number) => getDayName(d)),
            periodos: h.periodos || [],
            folga: h.folga || false,
          })),
        },
        horarioHoje,
      };
      }, CACHE_TTL.MEDIUM);

      if (!dados) {
        return notFoundResponse('Colaborador não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter jornada do colaborador:', error);
      return serverErrorResponse('Erro ao obter jornada');
    }
  });
}
