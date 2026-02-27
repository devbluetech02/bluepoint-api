import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const anexoId = parseInt(id);

      if (isNaN(anexoId)) {
        return notFoundResponse('Anexo não encontrado');
      }

      const result = await query(
        `SELECT nome, url, tipo FROM bt_anexos WHERE id = $1`,
        [anexoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Anexo não encontrado');
      }

      const anexo = result.rows[0];

      // Redirecionar para URL do arquivo
      return NextResponse.redirect(anexo.url);
    } catch (error) {
      console.error('Erro ao obter anexo:', error);
      return serverErrorResponse('Erro ao obter anexo');
    }
  });
}
