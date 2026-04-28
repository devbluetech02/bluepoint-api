import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ cargoId: string }>;
}

interface CargoUfRow {
  uf: string;
  salario: string | null;
  jornada_id: number | null;
  criado_em: string;
  atualizado_em: string;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { cargoId: cargoIdParam } = await params;
      const cargoId = parseInt(cargoIdParam);
      if (isNaN(cargoId)) return notFoundResponse('Cargo não encontrado');

      const existe = await query<{ id: number }>(
        'SELECT id FROM people.cargos WHERE id = $1',
        [cargoId],
      );
      if (existe.rows.length === 0) return notFoundResponse('Cargo não encontrado');

      const result = await query<CargoUfRow>(
        `SELECT uf, salario, jornada_id, criado_em, atualizado_em
           FROM people.cargos_uf
          WHERE cargo_id = $1
          ORDER BY uf ASC`,
        [cargoId],
      );

      return successResponse({
        cargoId,
        overrides: result.rows.map((r) => ({
          uf: r.uf,
          salario: r.salario != null ? parseFloat(r.salario) : null,
          jornadaId: r.jornada_id,
          criadoEm: r.criado_em,
          atualizadoEm: r.atualizado_em,
        })),
      });
    } catch (error) {
      console.error('Erro ao listar cargo_uf:', error);
      return serverErrorResponse('Erro ao listar variações por UF do cargo');
    }
  });
}
