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
      const marcacaoId = parseInt(id);

      if (isNaN(marcacaoId)) {
        return notFoundResponse('Marcação não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.MARCACAO}${marcacaoId}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT 
          m.*,
          c.id as colaborador_id,
          c.nome as colaborador_nome,
          c.jornada_id,
          j.nome as jornada_nome,
          j.tolerancia_entrada,
          j.tolerancia_saida,
          aj.id as ajustada_por_id,
          aj.nome as ajustada_por_nome
        FROM people.marcacoes m
        JOIN people.colaboradores c ON m.colaborador_id = c.id
        LEFT JOIN jornadas j ON c.jornada_id = j.id
        LEFT JOIN people.colaboradores aj ON m.ajustada_por = aj.id
        WHERE m.id = $1`,
        [marcacaoId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Buscar horário previsto da jornada para o dia
      const dataHora = new Date(row.data_hora);
      const diaSemana = dataHora.getDay();

      let jornadaPrevista = null;
      let divergencias = { atraso: 0, saidaAntecipada: 0 };

      if (row.jornada_id) {
        const horarioResult = await query(
          `SELECT * FROM people.jornada_horarios 
           WHERE jornada_id = $1 AND dia_semana = $2`,
          [row.jornada_id, diaSemana]
        );

        if (horarioResult.rows.length > 0) {
          const horario = horarioResult.rows[0];
          jornadaPrevista = {
            entrada: horario.entrada,
            saidaAlmoco: horario.saida_almoco,
            retornoAlmoco: horario.retorno_almoco,
            saida: horario.saida,
          };

          // Calcular divergências
          const horaRegistro = dataHora.toTimeString().substring(0, 5);
          
          if (row.tipo === 'entrada') {
            const entradaPrevista = horario.entrada.substring(0, 5);
            const minutosRegistro = parseInt(horaRegistro.split(':')[0]) * 60 + parseInt(horaRegistro.split(':')[1]);
            const minutosPrevisto = parseInt(entradaPrevista.split(':')[0]) * 60 + parseInt(entradaPrevista.split(':')[1]);
            const diferenca = minutosRegistro - minutosPrevisto;
            
            if (diferenca > (row.tolerancia_entrada || 0)) {
              divergencias.atraso = diferenca;
            }
          } else if (row.tipo === 'saida') {
            const saidaPrevista = horario.saida.substring(0, 5);
            const minutosRegistro = parseInt(horaRegistro.split(':')[0]) * 60 + parseInt(horaRegistro.split(':')[1]);
            const minutosPrevisto = parseInt(saidaPrevista.split(':')[0]) * 60 + parseInt(saidaPrevista.split(':')[1]);
            const diferenca = minutosPrevisto - minutosRegistro;
            
            if (diferenca > (row.tolerancia_saida || 0)) {
              divergencias.saidaAntecipada = diferenca;
            }
          } else if (row.tipo === 'almoco' && horario.saida_almoco) {
            // Comparar saída para almoço com o horário previsto de saída almoço
            const almocoPrevistoStr = horario.saida_almoco.substring(0, 5);
            const minutosRegistro = parseInt(horaRegistro.split(':')[0]) * 60 + parseInt(horaRegistro.split(':')[1]);
            const minutosPrevisto = parseInt(almocoPrevistoStr.split(':')[0]) * 60 + parseInt(almocoPrevistoStr.split(':')[1]);
            const diferenca = minutosRegistro - minutosPrevisto;
            
            if (Math.abs(diferenca) > (row.tolerancia_saida || 0)) {
              divergencias.saidaAntecipada = diferenca > 0 ? 0 : Math.abs(diferenca);
            }
          } else if (row.tipo === 'retorno' && horario.retorno_almoco) {
            // Comparar retorno do almoço com o horário previsto de retorno
            const retornoPrevistoStr = horario.retorno_almoco.substring(0, 5);
            const minutosRegistro = parseInt(horaRegistro.split(':')[0]) * 60 + parseInt(horaRegistro.split(':')[1]);
            const minutosPrevisto = parseInt(retornoPrevistoStr.split(':')[0]) * 60 + parseInt(retornoPrevistoStr.split(':')[1]);
            const diferenca = minutosRegistro - minutosPrevisto;
            
            if (diferenca > (row.tolerancia_entrada || 0)) {
              divergencias.atraso = diferenca;
            }
          }
        }
      }

      return {
        id: row.id,
        colaborador: {
          id: row.colaborador_id,
          nome: row.colaborador_nome,
        },
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
        jornadaPrevista,
        divergencias,
      };
      }, CACHE_TTL.SHORT);

      if (!dados) {
        return notFoundResponse('Marcação não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter marcação:', error);
      return serverErrorResponse('Erro ao obter marcação');
    }
  });
}
