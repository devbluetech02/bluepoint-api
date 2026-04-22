import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export type FormularioAdmissaoAtivoRow = {
  id: string;
  titulo: string;
  descricao: string | null;
  campos: unknown;
  token_publico: string | null;
  ativo: boolean;
  documentos_requeridos: unknown;
};

export async function fetchFormularioAdmissaoAtivo(): Promise<FormularioAdmissaoAtivoRow | null> {
  const result = await query(
    `SELECT id, titulo, descricao, campos, token_publico, ativo, documentos_requeridos
     FROM people.formularios_admissao
     WHERE ativo = true
     ORDER BY atualizado_em DESC
     LIMIT 1`
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as FormularioAdmissaoAtivoRow;
}

export async function fetchFormularioAdmissaoPorToken(
  token: string
): Promise<FormularioAdmissaoAtivoRow | null> {
  const result = await query(
    `SELECT id, titulo, descricao, campos, token_publico, ativo, documentos_requeridos
     FROM people.formularios_admissao
     WHERE token_publico = $1
     LIMIT 1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as FormularioAdmissaoAtivoRow;
}

export interface DocumentoRequeridoApi {
  tipoDocumentoId: number;
  codigo: string;
  label: string;
  obrigatorio: boolean;
  cargosOpcoes: string[];
}

/**
 * Recebe o JSONB documentos_requeridos do formulário e enriquece com codigo/label da tabela de tipos.
 * Se vazio, retorna todos os documentos de admissão sem restrição de cargo.
 */
export async function fetchDocumentosAdmissao(raw: unknown): Promise<DocumentoRequeridoApi[]> {
  const items = parseDocumentosRequeridos(raw);

  if (items.length === 0) {
    // Nenhuma config salva — retorna todos os tipos de admissão
    const result = await query(
      `SELECT id, codigo, nome_exibicao, obrigatorio_padrao
       FROM people.tipos_documento_colaborador
       WHERE 'admissao' = ANY(categorias)
       ORDER BY id`
    );
    return (result.rows as { id: number; codigo: string; nome_exibicao: string; obrigatorio_padrao: boolean }[]).map(
      (row) => ({
        tipoDocumentoId: row.id,
        codigo: row.codigo,
        label: row.nome_exibicao,
        obrigatorio: row.obrigatorio_padrao,
        cargosOpcoes: [],
      })
    );
  }

  // Busca label/codigo dos tipos referenciados
  const ids = [...new Set(items.map((i) => i.tipoDocumentoId))];
  const tiposResult = await query(
    `SELECT id, codigo, nome_exibicao
     FROM people.tipos_documento_colaborador
     WHERE id = ANY($1::int[])`,
    [ids]
  );
  const byId = new Map(
    (tiposResult.rows as { id: number; codigo: string; nome_exibicao: string }[]).map((r) => [
      r.id,
      r,
    ])
  );

  return items.map((item) => {
    const tipo = byId.get(item.tipoDocumentoId);
    return {
      tipoDocumentoId: item.tipoDocumentoId,
      codigo: tipo?.codigo ?? '',
      label: tipo?.nome_exibicao ?? '',
      obrigatorio: item.obrigatorio,
      cargosOpcoes: item.cargosOpcoes,
    };
  });
}

function parseDocumentosRequeridos(
  raw: unknown
): { tipoDocumentoId: number; obrigatorio: boolean; cargosOpcoes: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw
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
        cargosOpcoes: Array.isArray(item.cargosOpcoes)
          ? item.cargosOpcoes.filter((v): v is string => typeof v === 'string')
          : [],
      };
    })
    .filter((x): x is { tipoDocumentoId: number; obrigatorio: boolean; cargosOpcoes: string[] } => x !== null);
}

/**
 * Base URL for links sent to candidates (browser-openable).
 */
export function resolveFormularioAdmissaoPublicBaseUrl(request: NextRequest): string {
  const fromEnv =
    (process.env.FORMULARIO_ADMISSAO_FRONTEND_URL || '').trim() ||
    (process.env.FRONTEND_URL || '').trim() ||
    (process.env.APP_BASE_URL || '').trim() ||
    (process.env.NEXT_PUBLIC_APP_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  if (process.env.NODE_ENV === 'production') {
    console.warn('[formulario-admissao] FORMULARIO_ADMISSAO_FRONTEND_URL não configurada; usando host da requisição');
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  const urlForProto = new URL(request.url);
  const forwardedProto =
    request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ||
    urlForProto.protocol.replace(':', '');
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost.split(',')[0].trim()}`.replace(/\/$/, '');
  }

  const hostname = urlForProto.hostname;
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
    const port = urlForProto.port ? `:${urlForProto.port}` : '';
    return `${urlForProto.protocol}//localhost${port}`.replace(/\/$/, '');
  }
  return urlForProto.origin;
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

export function mapCamposParaApi(campos: unknown, apenasAtivos = false): FormularioCampoApi[] {
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
