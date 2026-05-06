import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';

// GET /api/v1/app/versao-atual?plataforma=android|ios
//
// Endpoint PUBLICO (sem auth) — chamado pelo UpdateService do mobile
// no boot pra decidir se mostra modal "Atualize o app". Quando vem
// sem `plataforma` retorna ambas.
//
// Resposta:
//   {
//     android: { versao, build, url, obrigatorioAcimaDeBuild },
//     ios:     { versao, build, url, obrigatorioAcimaDeBuild }
//   }
//
// Pra publicar nova versao na loja, basta `UPDATE people.app_versoes
// SET versao=..., build=..., atualizado_em=NOW() WHERE plataforma=...;`

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const plataforma = searchParams.get('plataforma');

    const rows = plataforma
      ? (await query<{
          plataforma: string;
          versao: string;
          build: number;
          url: string;
          obrigatorio_acima_de_build: number | null;
          atualizado_em: Date;
        }>(
          `SELECT plataforma, versao, build, url, obrigatorio_acima_de_build, atualizado_em
             FROM people.app_versoes WHERE plataforma = $1 LIMIT 1`,
          [plataforma],
        )).rows
      : (await query<{
          plataforma: string;
          versao: string;
          build: number;
          url: string;
          obrigatorio_acima_de_build: number | null;
          atualizado_em: Date;
        }>(
          `SELECT plataforma, versao, build, url, obrigatorio_acima_de_build, atualizado_em
             FROM people.app_versoes`,
        )).rows;

    const map: Record<string, unknown> = {};
    for (const r of rows) {
      map[r.plataforma] = {
        versao: r.versao,
        build: r.build,
        url: r.url,
        obrigatorioAcimaDeBuild: r.obrigatorio_acima_de_build,
        atualizadoEm: r.atualizado_em,
      };
    }

    return successResponse(map);
  } catch (error) {
    console.error('[app/versao-atual] erro:', error);
    return serverErrorResponse('Erro ao consultar versao do app');
  }
}
