import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, notFoundResponse, serverErrorResponse, successResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';
import { salvarFormularioAdmissaoSchema, validateBody } from '@/lib/validation';
import {
  buildFormularioAdmissaoPublicLink,
  fetchDocumentosAdmissao,
  fetchFormularioAdmissaoAtivo,
  fetchFormularioAdmissaoPorToken,
  mapCamposParaApi,
  mapCamposParaBanco,
} from '@/lib/formulario-admissao';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  // Public access via token
  if (token) {
    try {
      const row = await fetchFormularioAdmissaoPorToken(token);
      if (!row) {
        return errorResponse('Token inválido ou expirado', 403);
      }

      const documentosRequeridos = await fetchDocumentosAdmissao(row.documentos_requeridos);

      return successResponse({
        id: row.id,
        titulo: row.titulo,
        campos: mapCamposParaApi(row.campos, true),
        documentosRequeridos,
        token: row.token_publico,
      });
    } catch (error) {
      console.error('Erro ao obter formulário de admissão por token:', error);
      return serverErrorResponse('Erro ao obter formulário de admissão');
    }
  }

  // Gestor access via JWT
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
        token: row.token_publico,
      });
    } catch (error) {
      console.error('Erro ao obter formulário de admissão:', error);
      return serverErrorResponse('Erro ao obter formulário de admissão');
    }
  });
}

export async function POST(request: NextRequest) {
  return withAdmissao(request, async (req) => {
    try {
      const body = await req.json();
      const validation = validateBody(salvarFormularioAdmissaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;
      const campos = data.campos.map((campo, index) => ({
        id: campo.id || crypto.randomUUID(),
        label: campo.label,
        tipo: campo.tipo,
        obrigatorio: campo.obrigatorio,
        ativo: campo.ativo,
        ordem: campo.ordem || index + 1,
        opcoes: campo.opcoes || [],
        secaoNome: campo.secaoNome ?? null,
      }));
      const camposBanco = mapCamposParaBanco(campos);
      const documentosJson = JSON.stringify(
        (data.documentosRequeridos ?? []).map((d) => ({
          tipoDocumentoId: d.tipoDocumentoId,
          obrigatorio: d.obrigatorio,
          cargosOpcoes: d.cargosOpcoes ?? [],
        }))
      );

      const formId = data.id || crypto.randomUUID();

      if (data.id) {
        const existing = await query(
          `SELECT id, token_publico FROM people.formularios_admissao WHERE id = $1`,
          [formId]
        );
        if (existing.rows.length === 0) {
          return errorResponse('Formulário de admissão não encontrado', 404);
        }

        const updated = await query(
          `UPDATE people.formularios_admissao
           SET titulo = $2, descricao = $3, campos = $4::jsonb, documentos_requeridos = $5::jsonb
           WHERE id = $1
           RETURNING id, titulo, descricao, campos, token_publico, ativo, documentos_requeridos`,
          [formId, data.titulo, data.descricao || null, JSON.stringify(camposBanco), documentosJson]
        );

        const row = updated.rows[0];
        const documentosRequeridos = await fetchDocumentosAdmissao(row.documentos_requeridos);
        return successResponse({
          id: row.id,
          titulo: row.titulo,
          descricao: row.descricao,
          ativo: row.ativo,
          linkPublico: row.token_publico ? buildFormularioAdmissaoPublicLink(request, row.token_publico) : null,
          campos: mapCamposParaApi(row.campos),
          documentosRequeridos,
        });
      }

      const token = crypto.randomBytes(24).toString('hex');
      const inserted = await query(
        `INSERT INTO people.formularios_admissao
           (id, titulo, descricao, campos, token_publico, ativo, documentos_requeridos)
         VALUES ($1, $2, $3, $4::jsonb, $5, true, $6::jsonb)
         RETURNING id, titulo, descricao, campos, token_publico, ativo, documentos_requeridos`,
        [formId, data.titulo, data.descricao || null, JSON.stringify(camposBanco), token, documentosJson]
      );

      const row = inserted.rows[0];
      const documentosRequeridos = await fetchDocumentosAdmissao(row.documentos_requeridos);
      return createdResponse({
        id: row.id,
        titulo: row.titulo,
        descricao: row.descricao,
        ativo: row.ativo,
        linkPublico: buildFormularioAdmissaoPublicLink(request, row.token_publico),
        campos: mapCamposParaApi(row.campos),
        documentosRequeridos,
      });
    } catch (error) {
      console.error('Erro ao salvar formulário de admissão:', error);
      return serverErrorResponse('Erro ao salvar formulário de admissão');
    }
  });
}
