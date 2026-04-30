import { NextRequest } from 'next/server';
import { queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { successResponse, serverErrorResponse } from '@/lib/api-response';

// GET /api/v1/recrutamento/relatorio-performance/opcoes
//
// Devolve listas distintas pra popular dropdowns dos filtros do
// relatório de performance: vagas, UFs, recrutadores. Tudo de
// public.candidatos (banco de Recrutamento).

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const [vagasRes, ufsRes, recrutadoresRes] = await Promise.all([
        queryRecrutamento<{ vaga: string }>(
          `SELECT DISTINCT TRIM(vaga) AS vaga
             FROM public.candidatos
            WHERE vaga IS NOT NULL AND TRIM(vaga) <> ''
            ORDER BY vaga ASC`
        ),
        queryRecrutamento<{ uf: string }>(
          `SELECT DISTINCT UPPER(TRIM(uf)) AS uf
             FROM public.candidatos
            WHERE uf IS NOT NULL AND TRIM(uf) <> ''
            ORDER BY uf ASC`
        ),
        queryRecrutamento<{ recrutador: string }>(
          `SELECT DISTINCT UPPER(TRIM(responsavel_entrevista)) AS recrutador
             FROM public.candidatos
            WHERE responsavel_entrevista IS NOT NULL
              AND TRIM(responsavel_entrevista) <> ''
            ORDER BY recrutador ASC`
        ),
      ]);

      return successResponse({
        vagas: vagasRes.rows.map((r) => r.vaga),
        ufs: ufsRes.rows.map((r) => r.uf),
        recrutadores: recrutadoresRes.rows.map((r) => r.recrutador),
      });
    } catch (error) {
      console.error(
        '[recrutamento/relatorio-performance/opcoes] erro:',
        error
      );
      return serverErrorResponse('Erro ao listar opções do relatório');
    }
  });
}
