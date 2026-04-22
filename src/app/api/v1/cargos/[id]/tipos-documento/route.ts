import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAuth, withGestor } from '@/lib/middleware';
import { invalidateCargoCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/cargos/:id/tipos-documento
 * Para um cargo, retorna todos os tipos de documento com indicador se é obrigatório ou opcional.
 * Se não houver registro em cargo_tipo_documento, usa obrigatorio_padrao do tipo.
 */
export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cargoResult = await query(
        `SELECT id, nome FROM people.cargos WHERE id = $1`,
        [cargoId]
      );

      if (cargoResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }

      const result = await query(
        `SELECT t.id, t.codigo, t.nome_exibicao, t.validade_meses, t.obrigatorio_padrao, t.categorias,
                COALESCE(c.obrigatorio, t.obrigatorio_padrao) AS obrigatorio
         FROM people.tipos_documento_colaborador t
         LEFT JOIN people.cargo_tipo_documento c
           ON c.tipo_documento_id = t.id AND c.cargo_id = $1
         WHERE 'operacional' = ANY(t.categorias)
         ORDER BY t.id ASC`,
        [cargoId]
      );

      type TipoRow = {
        id: number;
        codigo: string;
        nome_exibicao: string;
        validade_meses: number | null;
        obrigatorio_padrao: boolean;
        obrigatorio: boolean;
        categorias: ('operacional' | 'admissao')[];
      };
      const tipos = (result.rows as TipoRow[]).map((row) => ({
        id: row.id,
        codigo: row.codigo,
        nomeExibicao: row.nome_exibicao,
        validadeMeses: row.validade_meses,
        obrigatorioPadrao: row.obrigatorio_padrao,
        obrigatorio: row.obrigatorio,
        categorias: row.categorias,
      }));

      return successResponse({
        cargoId,
        cargoNome: cargoResult.rows[0].nome,
        tipos,
      });
    } catch (error) {
      console.error('Erro ao listar tipos de documento do cargo:', error);
      return serverErrorResponse('Erro ao listar tipos de documento do cargo');
    }
  });
}

/**
 * PUT /api/v1/cargos/:id/tipos-documento
 * Body: { tipos: [{ tipoDocumentoId: number, obrigatorio: boolean }] }
 * Define quais tipos são obrigatórios/opcionais para o cargo.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cargoResult = await query(
        `SELECT id, nome FROM people.cargos WHERE id = $1`,
        [cargoId]
      );

      if (cargoResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }

      const body = await req.json();
      const { tipos } = body;

      if (!Array.isArray(tipos)) {
        return errorResponse('Campo "tipos" deve ser um array', 400);
      }

      const errors: Record<string, string[]> = {};
      const validTipos: { tipoDocumentoId: number; obrigatorio: boolean }[] = [];

      for (let i = 0; i < tipos.length; i++) {
        const t = tipos[i];
        if (typeof t.tipoDocumentoId !== 'number' || typeof t.obrigatorio !== 'boolean') {
          if (!errors['tipos']) errors['tipos'] = [];
          errors['tipos'].push(`Item ${i + 1}: tipoDocumentoId (número) e obrigatorio (boolean) são obrigatórios`);
        } else {
          validTipos.push({ tipoDocumentoId: t.tipoDocumentoId, obrigatorio: t.obrigatorio });
        }
      }

      if (Object.keys(errors).length > 0) {
        return validationErrorResponse(errors);
      }

      if (validTipos.length > 0) {
        const ids = [...new Set(validTipos.map((t) => t.tipoDocumentoId))];
        const permitidosResult = await query(
          `SELECT id
           FROM people.tipos_documento_colaborador
           WHERE id = ANY($1::int[])
             AND 'operacional' = ANY(categorias)`,
          [ids]
        );
        const idsPermitidos = new Set((permitidosResult.rows as { id: number }[]).map((r) => r.id));
        const invalidos = ids.filter((idTipo) => !idsPermitidos.has(idTipo));
        if (invalidos.length > 0) {
          return errorResponse(
            `Os tipos ${invalidos.join(', ')} não são do escopo operacional e não podem ser vinculados ao cargo`,
            400
          );
        }
      }

      await query('BEGIN', []);

      try {
        await query(
          `DELETE FROM people.cargo_tipo_documento WHERE cargo_id = $1`,
          [cargoId]
        );

        for (const t of validTipos) {
          await query(
            `INSERT INTO people.cargo_tipo_documento (cargo_id, tipo_documento_id, obrigatorio)
             VALUES ($1, $2, $3)
             ON CONFLICT (cargo_id, tipo_documento_id) DO UPDATE SET obrigatorio = $3`,
            [cargoId, t.tipoDocumentoId, t.obrigatorio]
          );
        }

        await query('COMMIT', []);
      } catch (e) {
        await query('ROLLBACK', []);
        throw e;
      }

      await invalidateCargoCache(cargoId);
      await cacheDelPattern(`${CACHE_KEYS.DOCUMENTOS}colaborador:*`);

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'cargos',
          descricao: `Tipos de documento do cargo "${cargoResult.rows[0].nome}" atualizados`,
          entidadeId: cargoId,
          entidadeTipo: 'cargo',
          dadosNovos: { tipos: validTipos },
        })
      );

      return successResponse({
        cargoId,
        mensagem: 'Tipos de documento do cargo atualizados',
        tipos: validTipos,
      });
    } catch (error) {
      console.error('Erro ao atualizar tipos de documento do cargo:', error);
      return serverErrorResponse('Erro ao atualizar tipos de documento do cargo');
    }
  });
}
