import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, forbiddenResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ sessao_id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAuth(request, async (_req, user) => {
    try {
      const { sessao_id } = await params;
      const sessaoId = parseInt(sessao_id, 10);

      if (Number.isNaN(sessaoId)) {
        return notFoundResponse('Sessão não encontrada');
      }

      const sessaoResult = await query(
        `SELECT id, data_sessao FROM people.esportes_sessoes WHERE id = $1`,
        [sessaoId],
      );

      if (sessaoResult.rows.length === 0) {
        return notFoundResponse('Sessão não encontrada');
      }

      const dataSessao = sessaoResult.rows[0].data_sessao as string;
      const hojeResult = await query(`SELECT CURRENT_DATE::text AS hoje`);
      const hoje = hojeResult.rows[0].hoje as string;

      if (dataSessao !== hoje) {
        return forbiddenResponse('Confirmação só é permitida no dia do jogo');
      }

      const updateResult = await query(
        `UPDATE people.esportes_inscricoes
         SET confirmado = true,
             confirmado_em = NOW()
         WHERE sessao_id = $1 AND colaborador_id = $2
         RETURNING id, colaborador_id, posicao, confirmado, confirmado_em`,
        [sessaoId, user.userId],
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

      if (!row.confirmado) {
        return errorResponse('Não foi possível confirmar a inscrição', 500);
      }

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
      console.error('Erro ao confirmar presença na sessão:', error);
      return serverErrorResponse('Erro ao confirmar presença na sessão');
    }
  });
}
