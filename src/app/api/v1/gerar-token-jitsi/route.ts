import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { query } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';

const JITSI_APP_SECRET = process.env.JITSI_APP_SECRET || '';

export async function POST(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      if (!JITSI_APP_SECRET) {
        return errorResponse('JITSI_APP_SECRET não configurado', 500);
      }

      const body = await request.json().catch(() => ({}));
      const room = body.room;

      if (!room) {
        return errorResponse('O campo room é obrigatório');
      }

      // Verificar se a sala existe e se o usuário é participante
      const reuniao = await query(
        `SELECT r.id, r.status
         FROM people.reunioes r
         WHERE r.sala = $1`,
        [room]
      );

      if (reuniao.rows.length === 0) {
        return errorResponse('Sala não encontrada', 404);
      }

      if (reuniao.rows[0].status === 'cancelada') {
        return errorResponse('Esta reunião foi cancelada');
      }

      const participante = await query(
        `SELECT 1 FROM people.reunioes_participantes
         WHERE reuniao_id = $1 AND colaborador_id = $2
         UNION
         SELECT 1 FROM people.reunioes
         WHERE id = $1 AND anfitriao_id = $2`,
        [reuniao.rows[0].id, user.userId]
      );

      if (participante.rows.length === 0) {
        return errorResponse('Você não é participante desta reunião', 403);
      }

      // Atualizar status para em_andamento se ainda estiver agendada
      if (reuniao.rows[0].status === 'agendada') {
        await query(
          `UPDATE people.reunioes SET status = 'em_andamento' WHERE id = $1`,
          [reuniao.rows[0].id]
        );
      }

      const now = Math.floor(Date.now() / 1000);
      const exp = now + 3600; // 1 hora

      const payload = {
        aud: 'people',
        iss: 'people',
        sub: 'localhost',
        room,
        exp,
        context: {
          user: {
            name: user.nome,
            email: user.email,
          },
        },
      };

      const token = jwt.sign(payload, JITSI_APP_SECRET, { algorithm: 'HS256' });

      return successResponse({ token });
    } catch (error) {
      console.error('Erro ao gerar token Jitsi:', error);
      return serverErrorResponse('Erro ao gerar token Jitsi');
    }
  });
}
