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
      const departamentoId = parseInt(id);

      if (isNaN(departamentoId)) {
        return notFoundResponse('Departamento não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.DEPARTAMENTO}${departamentoId}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT 
          d.*,
          g.id as gestor_id,
          g.nome as gestor_nome,
          (SELECT COUNT(*) FROM bluepoint.bt_colaboradores WHERE departamento_id = d.id AND status = 'ativo') as colaboradores
        FROM bt_departamentos d
        LEFT JOIN bluepoint.bt_colaboradores g ON d.gestor_id = g.id
        WHERE d.id = $1`,
        [departamentoId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        id: row.id,
        nome: row.nome,
        descricao: row.descricao,
        gestor: row.gestor_id ? { id: row.gestor_id, nome: row.gestor_nome } : null,
        colaboradores: parseInt(row.colaboradores),
        status: row.status,
        dataCriacao: row.criado_em,
      };
      }, CACHE_TTL.MEDIUM);

      if (!dados) {
        return notFoundResponse('Departamento não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter departamento:', error);
      return serverErrorResponse('Erro ao obter departamento');
    }
  });
}
