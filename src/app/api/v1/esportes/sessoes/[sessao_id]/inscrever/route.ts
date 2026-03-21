import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { inscricaoEsportesSchema, validateBody } from '@/lib/validation';

interface Params {
  params: Promise<{ sessao_id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
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

      const posicao = validation.data.posicao;

      const sessaoResult = await query(
        `SELECT id, total_vagas FROM bluepoint.bt_esportes_sessoes WHERE id = $1`,
        [sessaoId],
      );
      if (sessaoResult.rows.length === 0) {
        return notFoundResponse('Sessão não encontrada');
      }

      const jaInscrito = await query(
        `SELECT id FROM bluepoint.bt_esportes_inscricoes WHERE sessao_id = $1 AND colaborador_id = $2`,
        [sessaoId, user.userId],
      );
      if (jaInscrito.rows.length > 0) {
        return errorResponse('Usuário já inscrito nesta sessão', 409);
      }

      const lotacao = await query(
        `SELECT COUNT(*)::int AS total FROM bluepoint.bt_esportes_inscricoes WHERE sessao_id = $1`,
        [sessaoId],
      );
      const totalInscritos = lotacao.rows[0].total as number;
      const totalVagas = sessaoResult.rows[0].total_vagas as number;
      if (totalInscritos >= totalVagas) {
        return errorResponse('Vagas esgotadas para esta sessão', 409);
      }

      const insertResult = await query(
        `INSERT INTO bluepoint.bt_esportes_inscricoes (sessao_id, colaborador_id, posicao)
         VALUES ($1, $2, $3)
         RETURNING id, colaborador_id, posicao, confirmado, confirmado_em`,
        [sessaoId, user.userId, posicao],
      );

      const colaboradorResult = await query(
        `SELECT c.nome, d.nome AS departamento
         FROM bluepoint.bt_colaboradores c
         LEFT JOIN bluepoint.bt_departamentos d ON d.id = c.departamento_id
         WHERE c.id = $1`,
        [user.userId],
      );

      const row = insertResult.rows[0];
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
      console.error('Erro ao inscrever colaborador na sessão:', error);
      return serverErrorResponse('Erro ao inscrever colaborador na sessão');
    }
  });
}
