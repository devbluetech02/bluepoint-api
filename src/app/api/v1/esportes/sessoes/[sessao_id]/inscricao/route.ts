import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ sessao_id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAuth(request, async (_req, user) => {
    try {
      const { sessao_id } = await params;
      const sessaoId = parseInt(sessao_id, 10);

      if (Number.isNaN(sessaoId)) {
        return notFoundResponse('Sessão não encontrada');
      }

      const result = await query(
        `DELETE FROM people.esportes_inscricoes
         WHERE sessao_id = $1 AND colaborador_id = $2
         RETURNING id`,
        [sessaoId, user.userId],
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Inscrição não encontrada para o usuário autenticado');
      }

      return NextResponse.json({ message: 'Inscrição removida com sucesso' });
    } catch (error) {
      console.error('Erro ao remover inscrição da sessão:', error);
      return serverErrorResponse('Erro ao remover inscrição da sessão');
    }
  });
}
