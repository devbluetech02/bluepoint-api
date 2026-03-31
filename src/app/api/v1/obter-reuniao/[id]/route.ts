import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (_req, user) => {
    try {
      const { id } = await params;

      // Aceita busca por ID numérico ou pela sala (UUID)
      const isNumeric = /^\d+$/.test(id);

      const result = await query(
        `SELECT
          r.id,
          r.sala,
          r.titulo,
          r.descricao,
          r.data_inicio,
          r.data_fim,
          r.status,
          r.anfitriao_id,
          a.nome AS anfitriao_nome,
          a.email AS anfitriao_email,
          r.criado_em,
          r.atualizado_em
        FROM people.reunioes r
        JOIN people.colaboradores a ON r.anfitriao_id = a.id
        WHERE ${isNumeric ? 'r.id = $1' : 'r.sala = $1'}`,
        [isNumeric ? parseInt(id, 10) : id]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Reunião não encontrada');
      }

      const row = result.rows[0];

      // Verificar se o usuário é participante ou anfitrião
      const participanteCheck = await query(
        `SELECT 1 FROM people.reunioes_participantes
         WHERE reuniao_id = $1 AND colaborador_id = $2
         UNION
         SELECT 1 WHERE $3 = $2`,
        [row.id, user.userId, row.anfitriao_id]
      );

      if (participanteCheck.rows.length === 0) {
        return notFoundResponse('Reunião não encontrada');
      }

      // Buscar participantes
      const participantesResult = await query(
        `SELECT
          rp.colaborador_id,
          c.nome,
          c.email,
          rp.status
        FROM people.reunioes_participantes rp
        JOIN people.colaboradores c ON rp.colaborador_id = c.id
        WHERE rp.reuniao_id = $1
        ORDER BY c.nome`,
        [row.id]
      );

      return successResponse({
        id: row.id,
        sala: row.sala,
        titulo: row.titulo,
        descricao: row.descricao,
        dataInicio: row.data_inicio,
        dataFim: row.data_fim,
        status: row.status,
        link: `/reuniao/${row.sala}`,
        anfitriao: {
          id: row.anfitriao_id,
          nome: row.anfitriao_nome,
          email: row.anfitriao_email,
        },
        participantes: participantesResult.rows.map((p) => ({
          id: p.colaborador_id,
          nome: p.nome,
          email: p.email,
          status: p.status,
        })),
        criadoEm: row.criado_em,
        atualizadoEm: row.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao obter reunião:', error);
      return serverErrorResponse('Erro ao obter reunião');
    }
  });
}
