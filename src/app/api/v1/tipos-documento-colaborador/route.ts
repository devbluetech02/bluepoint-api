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

const CATEGORIAS_VALIDAS = ['operacional', 'admissao'] as const;
type Categoria = typeof CATEGORIAS_VALIDAS[number];

/**
 * GET /api/v1/tipos-documento-colaborador
 * Lista os tipos de documento. Filtra por ?categoria=operacional|admissao (match em array).
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const categoria = request.nextUrl.searchParams.get('categoria');
      if (categoria && !CATEGORIAS_VALIDAS.includes(categoria as Categoria)) {
        return errorResponse('Query param "categoria" deve ser "operacional" ou "admissao"', 400);
      }

      const cacheKey = `${CACHE_KEYS.DOCUMENTOS}tipos:${categoria || 'all'}`;

      const tipos = await cacheAside(cacheKey, async () => {
        const queryText = categoria
          ? `SELECT id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categorias
             FROM people.tipos_documento_colaborador
             WHERE $1 = ANY(categorias)
             ORDER BY id ASC`
          : `SELECT id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categorias
             FROM people.tipos_documento_colaborador
             ORDER BY id ASC`;
        const result = await query(queryText, categoria ? [categoria] : []);

        type TipoRow = {
          id: number;
          codigo: string;
          nome_exibicao: string;
          validade_meses: number | null;
          obrigatorio_padrao: boolean;
          categorias: string[];
        };
        return (result.rows as TipoRow[]).map((row) => ({
          id: row.id,
          codigo: row.codigo,
          nomeExibicao: row.nome_exibicao,
          validadeMeses: row.validade_meses,
          obrigatorioPadrao: row.obrigatorio_padrao,
          categorias: row.categorias,
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
 * Cria um novo tipo de documento ou adiciona categorias a um existente.
 * Body: { codigo, nomeExibicao, validadeMeses?, obrigatorioPadrao?, categorias: string[] }
 */
export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      const codigoRaw = body?.codigo;
      const nomeExibicaoRaw = body?.nomeExibicao;
      const validadeMesesRaw = body?.validadeMeses;
      const obrigatorioPadraoRaw = body?.obrigatorioPadrao;
      const categoriasRaw = body?.categorias ?? (body?.categoria ? [body.categoria] : undefined);

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

      if (categoriasRaw !== undefined) {
        if (!Array.isArray(categoriasRaw) || categoriasRaw.length === 0) {
          errors.categorias = ['Campo "categorias" deve ser um array não vazio'];
        } else if (categoriasRaw.some((c: unknown) => !CATEGORIAS_VALIDAS.includes(c as Categoria))) {
          errors.categorias = ['Categorias válidas: "operacional", "admissao"'];
        }
      }

      if (Object.keys(errors).length > 0) {
        return validationErrorResponse(errors);
      }

      const codigo = String(codigoRaw).trim().toLowerCase();
      const nomeExibicao = String(nomeExibicaoRaw).trim();
      const validadeMeses = validadeMesesRaw ?? null;
      const obrigatorioPadrao = obrigatorioPadraoRaw ?? true;
      const categorias: Categoria[] = categoriasRaw ?? ['operacional'];

      if (!/^[a-z0-9_]+$/.test(codigo)) {
        return errorResponse('Campo "codigo" deve conter apenas letras minúsculas, números e underscore', 400);
      }

      if (codigo.length > 50) {
        return errorResponse('Campo "codigo" deve ter no máximo 50 caracteres', 400);
      }

      if (nomeExibicao.length > 100) {
        return errorResponse('Campo "nomeExibicao" deve ter no máximo 100 caracteres', 400);
      }

      // Se já existe, adiciona as novas categorias ao array existente
      const existsResult = await query(
        `SELECT id, categorias FROM people.tipos_documento_colaborador WHERE codigo = $1 LIMIT 1`,
        [codigo]
      );

      if (existsResult.rows.length > 0) {
        const existing = existsResult.rows[0] as { id: number; categorias: string[] };
        const merged = [...new Set([...existing.categorias, ...categorias])];
        const updated = await query(
          `UPDATE people.tipos_documento_colaborador
           SET categorias = $2
           WHERE id = $1
           RETURNING id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categorias`,
          [existing.id, merged]
        );
        const row = updated.rows[0];
        await cacheDelPattern(`${CACHE_KEYS.DOCUMENTOS}tipos*`);
        return successResponse({
          id: row.id,
          codigo: row.codigo,
          nomeExibicao: row.nome_exibicao,
          validadeMeses: row.validade_meses,
          obrigatorioPadrao: row.obrigatorio_padrao,
          categorias: row.categorias,
        });
      }

      const insertResult = await query(
        `INSERT INTO people.tipos_documento_colaborador
          (codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categorias)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, codigo, nome_exibicao, validade_meses, obrigatorio_padrao, categorias`,
        [codigo, nomeExibicao, validadeMeses, obrigatorioPadrao, categorias]
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
            categorias: novoTipo.categorias,
          },
        })
      );

      return createdResponse({
        id: novoTipo.id,
        codigo: novoTipo.codigo,
        nomeExibicao: novoTipo.nome_exibicao,
        validadeMeses: novoTipo.validade_meses,
        obrigatorioPadrao: novoTipo.obrigatorio_padrao,
        categorias: novoTipo.categorias,
      });
    } catch (error) {
      console.error('Erro ao criar tipo de documento:', error);
      return serverErrorResponse('Erro ao criar tipo de documento');
    }
  });
}
