import { NextRequest } from 'next/server';
import { successResponse, notFoundResponse, forbiddenResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getDocumentosColaboradorCacheado } from '@/lib/colaborador-documentos';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (_req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const acesso = await asseguraAcessoColaborador(user, colaboradorId);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
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
