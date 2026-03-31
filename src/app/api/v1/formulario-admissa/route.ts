import { NextRequest } from 'next/server';
import { notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import {
  buildFormularioAdmissaoPublicLink,
  fetchFormularioAdmissaoAtivo,
  mapCamposParaApi,
  mapDocumentosRequeridosParaApi,
} from '@/lib/formulario-admissao';

function buildPublicLink(request: NextRequest, token: string | null): string | null {
  if (!token) return null;
  return buildFormularioAdmissaoPublicLink(request, token);
}

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const row = await fetchFormularioAdmissaoAtivo();
      if (!row) {
        return notFoundResponse('Formulário de admissão não encontrado');
      }

      const documentosRequeridos = await mapDocumentosRequeridosParaApi(row.documentos_requeridos ?? []);

      return successResponse({
        id: row.id,
        titulo: row.titulo,
        descricao: row.descricao,
        ativo: row.ativo,
        linkPublico: buildPublicLink(request, row.token_publico),
        campos: mapCamposParaApi(row.campos),
        documentosRequeridos,
      });
    } catch (error) {
      console.error('Erro ao obter formulário de admissão:', error);
      return serverErrorResponse('Erro ao obter formulário de admissão');
    }
  });
}
