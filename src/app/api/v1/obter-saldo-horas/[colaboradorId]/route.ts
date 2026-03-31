import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { minutesToHHMM } from '@/lib/utils';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.SALDO_HORAS}${colaboradorId}`;

      const dados = await cacheAside(cacheKey, async () => {
        // Buscar colaborador e saldo
        const result = await query(
          `SELECT 
            c.id,
            c.nome,
            bh.saldo_atual,
            bh.criado_em as ultima_atualizacao
          FROM people.colaboradores c
          LEFT JOIN (
            SELECT DISTINCT ON (colaborador_id) 
              colaborador_id, saldo_atual, criado_em
            FROM banco_horas
            ORDER BY colaborador_id, criado_em DESC
          ) bh ON c.id = bh.colaborador_id
          WHERE c.id = $1`,
          [colaboradorId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];
        const saldo = row.saldo_atual ? parseFloat(row.saldo_atual) : 0;
        const saldoMinutos = Math.round(saldo * 60);

        return {
          colaboradorId: row.id,
          nome: row.nome,
          saldo,
          saldoFormatado: minutesToHHMM(saldoMinutos),
          ultimaAtualizacao: row.ultima_atualizacao,
        };
      }, CACHE_TTL.SHORT);

      if (!dados) {
        return notFoundResponse('Colaborador não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter saldo de horas:', error);
      return serverErrorResponse('Erro ao obter saldo de horas');
    }
  });
}
