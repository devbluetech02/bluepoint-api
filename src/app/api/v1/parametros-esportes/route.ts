import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { parametrosEsportesSchema, validateBody } from '@/lib/validation';
import { buscarParametrosEsportes } from '@/lib/esportes';

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const parametros = await buscarParametrosEsportes();
      return Response.json({ data: parametros });
    } catch (error) {
      console.error('Erro ao buscar parâmetros de esportes:', error);
      return serverErrorResponse('Erro ao buscar parâmetros de esportes');
    }
  });
}

export async function PUT(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      const validation = validateBody(parametrosEsportesSchema, body);

      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const existe = await query(
        `SELECT id FROM people.parametros_esportes ORDER BY id DESC LIMIT 1`,
      );

      let result;
      if (existe.rows.length > 0) {
        result = await query(
          `UPDATE people.parametros_esportes
           SET dia_semana = $1,
               hora_inicio = $2::time,
               total_jogadores = $3,
               horas_jogo = $4,
               local = $5,
               ativo = $6,
               atualizado_por = $7
           WHERE id = $8
           RETURNING id, dia_semana, hora_inicio::text AS hora_inicio, total_jogadores, horas_jogo, local, ativo`,
          [
            data.dia_semana,
            data.hora_inicio,
            data.total_jogadores,
            data.horas_jogo,
            data.local,
            data.ativo,
            user.userId,
            existe.rows[0].id,
          ],
        );
      } else {
        result = await query(
          `INSERT INTO people.parametros_esportes
             (dia_semana, hora_inicio, total_jogadores, horas_jogo, local, ativo, atualizado_por)
           VALUES ($1, $2::time, $3, $4, $5, $6, $7)
           RETURNING id, dia_semana, hora_inicio::text AS hora_inicio, total_jogadores, horas_jogo, local, ativo`,
          [
            data.dia_semana,
            data.hora_inicio,
            data.total_jogadores,
            data.horas_jogo,
            data.local,
            data.ativo,
            user.userId,
          ],
        );
      }

      return Response.json({ data: result.rows[0] });
    } catch (error) {
      console.error('Erro ao salvar parâmetros de esportes:', error);
      return serverErrorResponse('Erro ao salvar parâmetros de esportes');
    }
  });
}
