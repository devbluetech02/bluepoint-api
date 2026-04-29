import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, notFoundResponse, serverErrorResponse, successResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor, withAdmin } from '@/lib/middleware';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

// =====================================================
// Schemas
// =====================================================

const campoSchema = z.object({
  id: z.string().optional().nullable(),
  label: z.string().min(1, 'Label é obrigatório').max(255),
  tipo: z.enum(['text', 'number', 'email', 'phone', 'cpf', 'date', 'select', 'checkbox', 'file', 'photo'] as const),
  obrigatorio: z.boolean().default(false),
  ativo: z.boolean().default(true),
  ordem: z.number().int().min(1, 'Ordem deve ser maior que 0'),
  opcoes: z.array(z.string()).default([]),
  secaoNome: z.string().max(255).optional().nullable(),
});

const documentoRequeridoSchema = z.object({
  tipoDocumentoId: z.number().int().positive('tipoDocumentoId inválido'),
  obrigatorio: z.boolean().default(false),
});

const salvarFormularioAtualizacaoCadastralSchema = z.object({
  id: z.string().uuid('ID inválido').optional(),
  titulo: z.string().min(3, 'Título deve ter no mínimo 3 caracteres').max(255),
  descricao: z.string().max(2000).optional().nullable(),
  campos: z.array(campoSchema).min(1, 'Pelo menos 1 campo é obrigatório'),
  documentosRequeridos: z.array(documentoRequeridoSchema).optional().default([]),
});

// =====================================================
// Helpers
// =====================================================

function mapCamposParaBanco(campos: z.infer<typeof campoSchema>[]) {
  return campos.map((campo) => ({
    id: campo.id ?? null,
    label: campo.label,
    tipo: campo.tipo,
    obrigatorio: campo.obrigatorio,
    ativo: campo.ativo,
    ordem: campo.ordem,
    opcoes: campo.opcoes,
    secao_nome: campo.secaoNome ?? null,
  }));
}

function mapCamposParaApi(campos: unknown, apenasAtivos = false) {
  if (!Array.isArray(campos)) return [];
  const mapped = campos.map((campo) => {
    const item = (campo ?? {}) as Record<string, unknown>;
    return {
      id: typeof item.id === 'string' ? item.id : null,
      label: typeof item.label === 'string' ? item.label : '',
      tipo: typeof item.tipo === 'string' ? item.tipo : '',
      obrigatorio: Boolean(item.obrigatorio),
      ativo: item.ativo === undefined ? true : Boolean(item.ativo),
      ordem: typeof item.ordem === 'number' ? item.ordem : 0,
      opcoes: Array.isArray(item.opcoes) ? item.opcoes.filter((v): v is string => typeof v === 'string') : [],
      secaoNome:
        typeof item.secao_nome === 'string'
          ? item.secao_nome
          : typeof item.secaoNome === 'string'
            ? item.secaoNome
            : null,
    };
  });
  return apenasAtivos ? mapped.filter((c) => c.ativo) : mapped;
}

async function fetchDocumentosRequeridos(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const items = raw
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const id =
        typeof item.tipoDocumentoId === 'number'
          ? item.tipoDocumentoId
          : typeof item.tipo_documento_id === 'number'
            ? item.tipo_documento_id
            : null;
      if (!id || !Number.isInteger(id) || id < 1) return null;
      return {
        tipoDocumentoId: id,
        obrigatorio: Boolean(item.obrigatorio),
      };
    })
    .filter((x): x is { tipoDocumentoId: number; obrigatorio: boolean } => x !== null);

  if (items.length === 0) return [];

  const ids = [...new Set(items.map((i) => i.tipoDocumentoId))];
  const tiposResult = await query(
    `SELECT id, codigo, nome_exibicao
     FROM people.tipos_documento_colaborador
     WHERE id = ANY($1::int[])`,
    [ids]
  );
  const byId = new Map(
    (tiposResult.rows as { id: number; codigo: string; nome_exibicao: string }[]).map((r) => [r.id, r])
  );

  return items.map((item) => {
    const tipo = byId.get(item.tipoDocumentoId);
    return {
      tipoDocumentoId: item.tipoDocumentoId,
      codigo: tipo?.codigo ?? '',
      label: tipo?.nome_exibicao ?? '',
      obrigatorio: item.obrigatorio,
    };
  });
}

// =====================================================
// GET — retorna o template ativo do formulário
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const result = await query(
        `SELECT id, titulo, descricao, campos, documentos_requeridos, ativo
         FROM people.formularios_atualizacao_cadastral
         WHERE ativo = true
         ORDER BY atualizado_em DESC
         LIMIT 1`
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Formulário de atualização cadastral não encontrado');
      }

      const row = result.rows[0];
      const documentosRequeridos = await fetchDocumentosRequeridos(row.documentos_requeridos);

      return successResponse({
        id: row.id,
        titulo: row.titulo,
        descricao: row.descricao,
        ativo: row.ativo,
        campos: mapCamposParaApi(row.campos, true),
        documentosRequeridos,
      });
    } catch (error) {
      console.error('Erro ao obter formulário de atualização cadastral:', error);
      return serverErrorResponse('Erro ao obter formulário de atualização cadastral');
    }
  });
}

// =====================================================
// POST — cria ou atualiza o template do formulário
// =====================================================

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req) => {
    try {
      const body = await req.json();
      const validation = validateBody(salvarFormularioAtualizacaoCadastralSchema, body);
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
        }))
      );

      const formId = data.id || crypto.randomUUID();

      if (data.id) {
        const existing = await query(
          `SELECT id FROM people.formularios_atualizacao_cadastral WHERE id = $1`,
          [formId]
        );
        if (existing.rows.length === 0) {
          return errorResponse('Formulário de atualização cadastral não encontrado', 404);
        }

        const updated = await query(
          `UPDATE people.formularios_atualizacao_cadastral
           SET titulo = $2, descricao = $3, campos = $4::jsonb, documentos_requeridos = $5::jsonb
           WHERE id = $1
           RETURNING id, titulo, descricao, campos, ativo, documentos_requeridos`,
          [formId, data.titulo, data.descricao || null, JSON.stringify(camposBanco), documentosJson]
        );

        const row = updated.rows[0];
        const documentosRequeridos = await fetchDocumentosRequeridos(row.documentos_requeridos);
        return successResponse({
          id: row.id,
          titulo: row.titulo,
          descricao: row.descricao,
          ativo: row.ativo,
          campos: mapCamposParaApi(row.campos),
          documentosRequeridos,
        });
      }

      const inserted = await query(
        `INSERT INTO people.formularios_atualizacao_cadastral
           (id, titulo, descricao, campos, ativo, documentos_requeridos)
         VALUES ($1, $2, $3, $4::jsonb, true, $5::jsonb)
         RETURNING id, titulo, descricao, campos, ativo, documentos_requeridos`,
        [formId, data.titulo, data.descricao || null, JSON.stringify(camposBanco), documentosJson]
      );

      const row = inserted.rows[0];
      const documentosRequeridos = await fetchDocumentosRequeridos(row.documentos_requeridos);
      return createdResponse({
        id: row.id,
        titulo: row.titulo,
        descricao: row.descricao,
        ativo: row.ativo,
        campos: mapCamposParaApi(row.campos),
        documentosRequeridos,
      });
    } catch (error) {
      console.error('Erro ao salvar formulário de atualização cadastral:', error);
      return serverErrorResponse('Erro ao salvar formulário de atualização cadastral');
    }
  });
}
