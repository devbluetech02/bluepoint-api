import { NextRequest } from 'next/server';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getDocumentosColaboradorCacheado } from '@/lib/colaborador-documentos';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const dados = await getDocumentosColaboradorCacheado(colaboradorId);
      if (dados == null) {
        return notFoundResponse('Colaborador não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar documentos:', error);
      return serverErrorResponse('Erro ao listar documentos');
    }
  });
}
