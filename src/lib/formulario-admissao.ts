import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

/** PostgreSQL undefined_column — happens if migration 006 was not applied yet. */
export function isMissingDocumentosRequeridosColumn(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  if (e?.code !== '42703') return false;
  return typeof e.message === 'string' && e.message.includes('documentos_requeridos');
}

export type FormularioAdmissaoAtivoRow = {
  id: string;
  titulo: string;
  descricao: string | null;
  campos: unknown;
  token_publico: string | null;
  ativo: boolean;
  documentos_requeridos: unknown;
};

/**
 * Loads the latest active admission form. Works before/after migration 006 (documentos_requeridos).
 */
export async function fetchFormularioAdmissaoAtivo(): Promise<FormularioAdmissaoAtivoRow | null> {
  const withDocs = `SELECT id, titulo, descricao, campos, token_publico, ativo, documentos_requeridos
     FROM people.formularios_admissao
     WHERE ativo = true
     ORDER BY atualizado_em DESC
     LIMIT 1`;
  const withoutDocs = `SELECT id, titulo, descricao, campos, token_publico, ativo
     FROM people.formularios_admissao
     WHERE ativo = true
     ORDER BY atualizado_em DESC
     LIMIT 1`;

  try {
    const result = await query(withDocs);
    if (result.rows.length === 0) return null;
    return result.rows[0] as FormularioAdmissaoAtivoRow;
  } catch (err) {
    if (!isMissingDocumentosRequeridosColumn(err)) throw err;
    const result = await query(withoutDocs);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Omit<FormularioAdmissaoAtivoRow, 'documentos_requeridos'>;
    return { ...row, documentos_requeridos: [] };
  }
}

/**
 * Base URL for links sent to candidates (browser-openable).
 * Prefer env; never use 0.0.0.0 as hostname (invalid in browsers).
 */
export function resolveFormularioAdmissaoPublicBaseUrl(request: NextRequest): string {
  const fromEnv =
    (process.env.FORMULARIO_ADMISSAO_FRONTEND_URL || '').trim() ||
    (process.env.FRONTEND_URL || '').trim() ||
    (process.env.APP_BASE_URL || '').trim() ||
    (process.env.NEXT_PUBLIC_APP_URL || '').trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, '');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Configure FORMULARIO_ADMISSAO_FRONTEND_URL ou FRONTEND_URL para gerar link público de admissão'
    );
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  const urlForProto = new URL(request.url);
  const forwardedProto =
    request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ||
    urlForProto.protocol.replace(':', '');
  if (forwardedHost) {
    const host = forwardedHost.split(',')[0].trim();
    return `${forwardedProto}://${host}`.replace(/\/$/, '');
  }

  const url = urlForProto;
  const hostname = url.hostname;
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//localhost${port}`.replace(/\/$/, '');
  }

  return url.origin;
}

function resolveFormularioAdmissaoFrontendPath(): string {
  const rawPath = (process.env.FORMULARIO_ADMISSAO_FRONTEND_PATH || '/form').trim();
  if (!rawPath) return '/form';
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

export function buildFormularioAdmissaoPublicLink(request: NextRequest, token: string): string {
  const baseUrl = resolveFormularioAdmissaoPublicBaseUrl(request);
  const path = resolveFormularioAdmissaoFrontendPath();
  const url = new URL(path, `${baseUrl}/`);
  url.searchParams.set('token', token);
  return url.toString();
}

export interface DocumentoRequeridoApi {
  tipoDocumentoId: number;
  codigo: string;
  label: string;
  obrigatorio: boolean;
}

export interface FormularioCampoApi {
  id?: string | null;
  label: string;
  tipo: string;
  obrigatorio: boolean;
  ativo: boolean;
  ordem: number;
  opcoes: string[];
  secaoNome?: string | null;
}

export interface FormularioCampoDb {
  id?: string | null;
  label: string;
  tipo: string;
  obrigatorio: boolean;
  ativo: boolean;
  ordem: number;
  opcoes: string[];
  secao_nome?: string | null;
}

export function mapCamposParaBanco(campos: FormularioCampoApi[]): FormularioCampoDb[] {
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

export function mapCamposParaApi(campos: unknown): FormularioCampoApi[] {
  if (!Array.isArray(campos)) return [];

  return campos.map((campo) => {
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
}

export function parseDocumentosRequeridosItems(raw: unknown): { tipoDocumentoId: number; obrigatorio: boolean }[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const idRaw =
        typeof item.tipoDocumentoId === 'number'
          ? item.tipoDocumentoId
          : typeof item.tipo_documento_id === 'number'
            ? item.tipo_documento_id
            : null;
      if (idRaw == null || !Number.isInteger(idRaw) || idRaw < 1) return null;
      return {
        tipoDocumentoId: idRaw,
        obrigatorio: item.obrigatorio === undefined ? false : Boolean(item.obrigatorio),
      };
    })
    .filter((x): x is { tipoDocumentoId: number; obrigatorio: boolean } => x !== null);
}

export async function mapDocumentosRequeridosParaApi(raw: unknown): Promise<DocumentoRequeridoApi[]> {
  const items = parseDocumentosRequeridosItems(raw);
  if (items.length === 0) return [];

  const ids = [...new Set(items.map((i) => i.tipoDocumentoId))];
  const result = await query(
    `SELECT id, codigo, nome_exibicao
     FROM people.tipos_documento_colaborador
     WHERE id = ANY($1::int[])
       AND categoria = 'admissao'`,
    [ids]
  );

  const byId = new Map<number, { codigo: string; nome_exibicao: string }>();
  for (const row of result.rows as { id: number; codigo: string; nome_exibicao: string }[]) {
    byId.set(row.id, { codigo: row.codigo, nome_exibicao: row.nome_exibicao });
  }

  return items.map((item) => {
    const t = byId.get(item.tipoDocumentoId);
    return {
      tipoDocumentoId: item.tipoDocumentoId,
      codigo: t?.codigo ?? '',
      label: t?.nome_exibicao ?? '',
      obrigatorio: item.obrigatorio,
    };
  });
}
