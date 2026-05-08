import { NextRequest } from 'next/server';
import { z } from 'zod';
import { queryRecrutamento, queryRecrutamentoWrite } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { successResponse, serverErrorResponse, errorResponse } from '@/lib/api-response';
import { getVideoDurationSeconds } from '@/lib/drive-video';

// POST /api/v1/recrutamento/entrevistas/sync-duracao
//
// Varre entrevistas_agendadas com video_id valido + duracao_seg NULL e
// preenche duracao_seg consultando Drive API (videoMediaMetadata).
//
// Body opcional: { limite?: number } — default 50, max 500. Para evitar
// rodar tudo de uma vez (Drive rate limit ~1000 req/100s/usuario).

const schema = z.object({
  limite: z.number().int().min(1).max(500).optional(),
  forcarRefresh: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req) => {
    try {
      const body = await req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0]?.message ?? 'payload invalido', 400);
      }
      const limite = parsed.data.limite ?? 50;
      const forcar = parsed.data.forcarRefresh ?? false;

      const where = forcar
        ? `video_id IS NOT NULL AND video_id <> '' AND video_id NOT LIKE 'SEM%'`
        : `video_id IS NOT NULL AND video_id <> '' AND video_id NOT LIKE 'SEM%' AND duracao_seg IS NULL`;

      const lista = await queryRecrutamento<{ id: number; video_id: string }>(
        `SELECT id, video_id
           FROM public.entrevistas_agendadas
          WHERE ${where}
          ORDER BY id DESC
          LIMIT $1`,
        [limite],
      );

      let atualizadas = 0;
      let falhas = 0;
      const erros: { id: number; erro: string }[] = [];

      for (const row of lista.rows) {
        const r = await getVideoDurationSeconds(row.video_id);
        if (!r.ok || r.duracaoSegundos == null) {
          falhas++;
          erros.push({ id: row.id, erro: r.erro ?? 'desconhecido' });
          continue;
        }
        await queryRecrutamentoWrite(
          `UPDATE public.entrevistas_agendadas SET duracao_seg = $1 WHERE id = $2`,
          [r.duracaoSegundos, row.id],
        );
        atualizadas++;
      }

      return successResponse({
        candidatos: lista.rows.length,
        atualizadas,
        falhas,
        erros: erros.slice(0, 20),
      });
    } catch (error) {
      console.error('[recrutamento/entrevistas/sync-duracao] erro:', error);
      return serverErrorResponse('Erro ao sincronizar duracao das entrevistas');
    }
  });
}
