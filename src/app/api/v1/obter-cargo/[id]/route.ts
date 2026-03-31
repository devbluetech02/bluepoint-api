import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.CARGO}${cargoId}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT id, nome, cbo, descricao, salario_medio, valor_hora_extra_75, created_at, updated_at
         FROM people.cargos
         WHERE id = $1`,
        [cargoId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const cargo = result.rows[0];

      return {
        id: cargo.id,
        nome: cargo.nome,
        cbo: cargo.cbo,
        descricao: cargo.descricao,
        salarioMedio: cargo.salario_medio ? parseFloat(cargo.salario_medio) : null,
        valorHoraExtra75: cargo.valor_hora_extra_75 ? parseFloat(cargo.valor_hora_extra_75) : null,
        criadoEm: cargo.created_at,
        atualizadoEm: cargo.updated_at,
      };
      }, CACHE_TTL.LONG);

      if (!dados) {
        return notFoundResponse('Cargo não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter cargo:', error);
      return serverErrorResponse('Erro ao obter cargo');
    }
  });
}
