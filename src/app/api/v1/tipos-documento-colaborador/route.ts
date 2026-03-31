import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  serverErrorResponse,
  createdResponse,
  errorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAuth, withGestor } from '@/lib/middleware';
import { cacheAside, cacheDelPattern, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

/**
 * GET /api/v1/tipos-documento-colaborador
 * Lista os tipos de documento (ASO, EPI, CNH, etc.) com validade e obrigatoriedade padrão.
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const categoria = request.nextUrl.searchParams.get('categoria');
      if (categoria && categoria !== 'operacional' && categoria !== 'admissao') {
        return errorResponse('Query param "categoria" deve ser "operacional" ou "admissao"', 400);
      }

      const cacheKey = `${CACHE_KEYS.DOCUMENTOS}tipos:${categoria || 'all'}`;

      const tipos = await cacheAside(cacheKey, async () => {
        const queryText = categoria
          ? `SELECT id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categoria
             FROM people.tipos_documento_colaborador
             WHERE categoria = $1
             ORDER BY id ASC`
          : `SELECT id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categoria
           FROM people.tipos_documento_colaborador
           ORDER BY id ASC`;
        const result = await query(queryText, categoria ? [categoria] : []);

        type TipoRow = {
          id: number;
          codigo: string;
          nome_exibicao: string;
          validade_meses: number | null;
          obrigatorio_padrao: boolean;
          categoria: 'operacional' | 'admissao';
        };
        return (result.rows as TipoRow[]).map((row) => ({
          id: row.id,
          codigo: row.codigo,
          nomeExibicao: row.nome_exibicao,
          validadeMeses: row.validade_meses,
          obrigatorioPadrao: row.obrigatorio_padrao,
          categoria: row.categoria,
        }));
      }, CACHE_TTL.LONG);

      return successResponse({ tipos });
    } catch (error) {
      console.error('Erro ao listar tipos de documento:', error);
      return serverErrorResponse('Erro ao listar tipos de documento');
    }
  });
}

/**
 * POST /api/v1/tipos-documento-colaborador
 * Cria um novo tipo de documento (ex.: ASO, EPI, CNH).
 */
export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      const codigoRaw = body?.codigo;
      const nomeExibicaoRaw = body?.nomeExibicao;
      const validadeMesesRaw = body?.validadeMeses;
      const obrigatorioPadraoRaw = body?.obrigatorioPadrao;
      const categoriaRaw = body?.categoria;

      const errors: Record<string, string[]> = {};

      if (typeof codigoRaw !== 'string' || !codigoRaw.trim()) {
        errors.codigo = ['Campo "codigo" é obrigatório'];
      }

      if (typeof nomeExibicaoRaw !== 'string' || !nomeExibicaoRaw.trim()) {
        errors.nomeExibicao = ['Campo "nomeExibicao" é obrigatório'];
      }

      if (
        validadeMesesRaw !== undefined &&
        validadeMesesRaw !== null &&
        (!Number.isInteger(validadeMesesRaw) || validadeMesesRaw <= 0)
      ) {
        errors.validadeMeses = ['Campo "validadeMeses" deve ser inteiro positivo ou null'];
      }

      if (obrigatorioPadraoRaw !== undefined && typeof obrigatorioPadraoRaw !== 'boolean') {
        errors.obrigatorioPadrao = ['Campo "obrigatorioPadrao" deve ser boolean'];
      }

      if (
        categoriaRaw !== undefined &&
        categoriaRaw !== 'operacional' &&
        categoriaRaw !== 'admissao'
      ) {
        errors.categoria = ['Campo "categoria" deve ser "operacional" ou "admissao"'];
      }

      if (Object.keys(errors).length > 0) {
        return validationErrorResponse(errors);
      }

      const codigo = String(codigoRaw).trim().toLowerCase();
      const nomeExibicao = String(nomeExibicaoRaw).trim();
      const validadeMeses = validadeMesesRaw ?? null;
      const obrigatorioPadrao = obrigatorioPadraoRaw ?? true;
      const categoria = (categoriaRaw ?? 'operacional') as 'operacional' | 'admissao';

      if (!/^[a-z0-9_]+$/.test(codigo)) {
        return errorResponse('Campo "codigo" deve conter apenas letras minúsculas, números e underscore', 400);
      }

      if (codigo.length > 50) {
        return errorResponse('Campo "codigo" deve ter no máximo 50 caracteres', 400);
      }

      if (nomeExibicao.length > 100) {
        return errorResponse('Campo "nomeExibicao" deve ter no máximo 100 caracteres', 400);
      }

      const existsResult = await query(
        `SELECT id FROM people.tipos_documento_colaborador WHERE codigo = $1 LIMIT 1`,
        [codigo]
      );

      if (existsResult.rows.length > 0) {
        return errorResponse('Já existe um tipo de documento com este código', 409);
      }

      const insertResult = await query(
        `INSERT INTO people.tipos_documento_colaborador
          (codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categoria)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categoria`,
        [codigo, nomeExibicao, validadeMeses, obrigatorioPadrao, categoria]
      );

      const novoTipo = insertResult.rows[0];

      await cacheDelPattern(`${CACHE_KEYS.DOCUMENTOS}tipos*`);

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'criar',
          modulo: 'colaboradores',
          descricao: `Tipo de documento "${novoTipo.nome_exibicao}" criado`,
          entidadeId: novoTipo.id,
          entidadeTipo: 'tipo_documento_colaborador',
          dadosNovos: {
            id: novoTipo.id,
            codigo: novoTipo.codigo,
            nomeExibicao: novoTipo.nome_exibicao,
            validadeMeses: novoTipo.validade_meses,
            obrigatorioPadrao: novoTipo.obrigatorio_padrao,
            categoria: novoTipo.categoria,
          },
        })
      );

      return createdResponse({
        id: novoTipo.id,
        codigo: novoTipo.codigo,
        nomeExibicao: novoTipo.nome_exibicao,
        validadeMeses: novoTipo.validade_meses,
        obrigatorioPadrao: novoTipo.obrigatorio_padrao,
        categoria: novoTipo.categoria,
      });
    } catch (error) {
      console.error('Erro ao criar tipo de documento:', error);
      return serverErrorResponse('Erro ao criar tipo de documento');
    }
  });
}
