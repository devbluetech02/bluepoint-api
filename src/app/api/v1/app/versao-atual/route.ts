import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

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

// =============================================================================
// PUT /api/v1/app/versao-atual?plataforma=android|ios
//
// Atualiza a linha da plataforma em people.app_versoes — chamado pela
// tela "Versão do App" em Configurações → Parâmetros depois que uma
// nova versão é aprovada/publicada na loja. Restrito a admin.
// =============================================================================

const putSchema = z.object({
  versao: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/, 'versao deve estar no formato X.Y.Z'),
  build: z.number().int().min(1).max(1000000),
  url: z.string().url().max(500).optional(),
  obrigatorioAcimaDeBuild: z.number().int().min(0).max(1000000).nullable().optional(),
});

export async function PUT(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const plataforma = searchParams.get('plataforma');
      if (plataforma !== 'android' && plataforma !== 'ios') {
        return errorResponse('plataforma deve ser android ou ios', 400);
      }

      const body = await req.json().catch(() => ({}));
      const parsed = putSchema.safeParse(body);
      if (!parsed.success) {
        return validationErrorResponse(
          Object.fromEntries(
            parsed.error.issues.map((i) => [
              i.path.join('.') || 'body',
              [i.message],
            ]),
          ),
        );
      }
      const { versao, build, url, obrigatorioAcimaDeBuild } = parsed.data;

      // Atualização parcial — só sobrescreve url/obrigatorio_acima_de_build
      // se vieram no body. Evita sobrescrever url da loja por engano.
      const result = await query<{
        plataforma: string;
        versao: string;
        build: number;
        url: string;
        obrigatorio_acima_de_build: number | null;
        atualizado_em: Date;
      }>(
        `UPDATE people.app_versoes
            SET versao = $2,
                build = $3,
                url = COALESCE($4, url),
                obrigatorio_acima_de_build = CASE
                  WHEN $5::text IS NULL THEN obrigatorio_acima_de_build
                  WHEN $5::text = 'null' THEN NULL
                  ELSE $5::int
                END,
                atualizado_em = NOW(),
                atualizado_por = $6
          WHERE plataforma = $1
        RETURNING plataforma, versao, build, url,
                  obrigatorio_acima_de_build, atualizado_em`,
        [
          plataforma,
          versao,
          build,
          url ?? null,
          obrigatorioAcimaDeBuild === undefined
            ? null
            : obrigatorioAcimaDeBuild === null
              ? 'null'
              : String(obrigatorioAcimaDeBuild),
          user.userId,
        ],
      );

      if (result.rows.length === 0) {
        return errorResponse(
          `Plataforma ${plataforma} nao existe em people.app_versoes`,
          404,
        );
      }

      const r = result.rows[0];

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'configuracoes',
        descricao: `Versao publicada do app (${plataforma}) atualizada para ${versao} build ${build}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          plataforma,
          versao,
          build,
          url: r.url,
          obrigatorioAcimaDeBuild: r.obrigatorio_acima_de_build,
        },
      });

      return successResponse({
        plataforma: r.plataforma,
        versao: r.versao,
        build: r.build,
        url: r.url,
        obrigatorioAcimaDeBuild: r.obrigatorio_acima_de_build,
        atualizadoEm: r.atualizado_em,
      });
    } catch (error) {
      console.error('[app/versao-atual] PUT erro:', error);
      return serverErrorResponse('Erro ao atualizar versao do app');
    }
  });
}
