import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { inscricaoEsportesSchema, validateBody } from '@/lib/validation';

interface Params {
  params: Promise<{ sessao_id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { sessao_id } = await params;
      const sessaoId = parseInt(sessao_id, 10);

      if (Number.isNaN(sessaoId)) {
        return notFoundResponse('Sessão não encontrada');
      }

      const body = await req.json();
      const validation = validateBody(inscricaoEsportesSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const updateResult = await query(
        `UPDATE people.esportes_inscricoes
         SET posicao = $1
         WHERE sessao_id = $2 AND colaborador_id = $3
         RETURNING id, colaborador_id, posicao, confirmado, confirmado_em`,
        [validation.data.posicao, sessaoId, user.userId],
      );

      if (updateResult.rows.length === 0) {
        return notFoundResponse('Inscrição não encontrada para o usuário autenticado');
      }

      const colaboradorResult = await query(
        `SELECT c.nome, d.nome AS departamento
         FROM people.colaboradores c
         LEFT JOIN people.departamentos d ON d.id = c.departamento_id
         WHERE c.id = $1`,
        [user.userId],
      );

      const row = updateResult.rows[0];
      const colaborador = colaboradorResult.rows[0];

      return Response.json({
        data: {
          id: row.id,
          colaborador_id: row.colaborador_id,
          nome: colaborador?.nome ?? user.nome,
          departamento: colaborador?.departamento ?? null,
          posicao: row.posicao,
          confirmado: row.confirmado,
          confirmado_em: row.confirmado_em,
          sou_eu: true,
        },
      });
    } catch (error) {
      console.error('Erro ao atualizar posição da inscrição:', error);
      return serverErrorResponse('Erro ao atualizar posição da inscrição');
    }
  });
}
