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
import { invalidateCargoCache } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

type ExameRow = { id: number; nome: string };

async function listarExamesDoCargo(cargoId: number): Promise<ExameRow[]> {
  const result = await query(
    `SELECT e.id, e.nome
     FROM people.cargos_exames ce
     JOIN people.exames e ON e.id = ce.exame_id
     WHERE ce.cargo_id = $1
     ORDER BY e.nome ASC`,
    [cargoId]
  );
  return result.rows as ExameRow[];
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cargoResult = await query(
        `SELECT id FROM people.cargos WHERE id = $1`,
        [cargoId]
      );
      if (cargoResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }

      const exames = await listarExamesDoCargo(cargoId);
      return successResponse({ exames });
    } catch (error) {
      console.error('Erro ao listar exames do cargo:', error);
      return serverErrorResponse('Erro ao listar exames do cargo');
    }
  });
}

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
      const { exameIds } = body ?? {};

      if (!Array.isArray(exameIds)) {
        return validationErrorResponse({ exameIds: ['Campo "exameIds" deve ser um array de números'] });
      }
      if (exameIds.some((v) => !Number.isInteger(v) || v <= 0)) {
        return validationErrorResponse({ exameIds: ['Todos os itens devem ser inteiros positivos'] });
      }

      const idsUnicos = [...new Set(exameIds as number[])];

      if (idsUnicos.length > 0) {
        const existentes = await query(
          `SELECT id FROM people.exames WHERE id = ANY($1::int[])`,
          [idsUnicos]
        );
        const encontrados = new Set((existentes.rows as { id: number }[]).map((r) => r.id));
        const invalidos = idsUnicos.filter((i) => !encontrados.has(i));
        if (invalidos.length > 0) {
          return errorResponse(
            `Exames não encontrados no catálogo: ${invalidos.join(', ')}`,
            400
          );
        }
      }

      await query('BEGIN', []);
      try {
        await query(`DELETE FROM people.cargos_exames WHERE cargo_id = $1`, [cargoId]);
        for (const exameId of idsUnicos) {
          await query(
            `INSERT INTO people.cargos_exames (cargo_id, exame_id) VALUES ($1, $2)`,
            [cargoId, exameId]
          );
        }
        await query('COMMIT', []);
      } catch (e) {
        await query('ROLLBACK', []);
        throw e;
      }

      await invalidateCargoCache(cargoId);

      const exames = await listarExamesDoCargo(cargoId);

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'cargos',
          descricao: `Exames do cargo "${cargoResult.rows[0].nome}" atualizados (${idsUnicos.length} vínculos)`,
          entidadeId: cargoId,
          entidadeTipo: 'cargo',
          dadosNovos: { exameIds: idsUnicos },
        })
      );

      return successResponse({ exames });
    } catch (error) {
      console.error('Erro ao atualizar exames do cargo:', error);
      return serverErrorResponse('Erro ao atualizar exames do cargo');
    }
  });
}
