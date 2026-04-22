import { NextRequest } from 'next/server';
import { notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';
import {
  buildFormularioAdmissaoPublicLink,
  fetchDocumentosAdmissao,
  fetchFormularioAdmissaoAtivo,
  mapCamposParaApi,
} from '@/lib/formulario-admissao';

export async function GET(request: NextRequest) {
  return withAdmissao(request, async () => {
    try {
      const row = await fetchFormularioAdmissaoAtivo();
      if (!row) {
        return notFoundResponse('Formulário de admissão não encontrado');
      }

      const documentosRequeridos = await fetchDocumentosAdmissao(row.documentos_requeridos);

      return successResponse({
        id: row.id,
        titulo: row.titulo,
        descricao: row.descricao,
        ativo: row.ativo,
        linkPublico: row.token_publico ? buildFormularioAdmissaoPublicLink(request, row.token_publico) : null,
        campos: mapCamposParaApi(row.campos, true),
        documentosRequeridos,
      });
    } catch (error) {
      console.error('Erro ao obter formulário de admissão:', error);
      return serverErrorResponse('Erro ao obter formulário de admissão');
    }
  });
}
