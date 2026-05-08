import { queryRecrutamento, queryRecrutamentoWrite } from './db';
import { getVideoDurationSeconds } from './drive-video';

// ─────────────────────────────────────────────────────────────────────────────
// Entrevistas — duracao do video via Drive API
//
// Cron interno que varre periodicamente entrevistas_agendadas com video_id
// valido + duracao_seg NULL e popula `duracao_seg` consultando o Google
// Drive (videoMediaMetadata.durationMillis).
//
// Roda no boot do api (instrumentation.ts) — primeiro ciclo 90s apos start
// (deixa load inicial passar) e depois a cada 3 min. Cada ciclo processa
// no maximo 30 entrevistas pra nao estourar rate limit do Drive
// (~1000 req/100s/usuario com folga).
// ─────────────────────────────────────────────────────────────────────────────

const INTERVALO_MS = 3 * 60 * 1000;
const DELAY_INICIAL_MS = 90 * 1000;
const LIMITE_POR_CICLO = 30;

let timerRef: ReturnType<typeof setInterval> | null = null;

async function executarCiclo(): Promise<void> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Sem credenciais — checker fica inativo silenciosamente. Evita
    // logar warning a cada 3 min.
    return;
  }

  let pendentes: { id: number; video_id: string }[] = [];
  try {
    const r = await queryRecrutamento<{ id: number; video_id: string }>(
      `SELECT id, video_id
         FROM public.entrevistas_agendadas
        WHERE video_id IS NOT NULL
          AND video_id <> ''
          AND video_id NOT LIKE 'SEM%'
          AND duracao_seg IS NULL
        ORDER BY id DESC
        LIMIT $1`,
      [LIMITE_POR_CICLO],
    );
    pendentes = r.rows;
  } catch (e) {
    console.error('[Entrevistas Duracao Checker] Falha ao buscar pendentes:', e);
    return;
  }

  if (pendentes.length === 0) return;

  let ok = 0;
  let falhas = 0;
  for (const row of pendentes) {
    const r = await getVideoDurationSeconds(row.video_id);
    if (!r.ok || r.duracaoSegundos == null) {
      falhas++;
      continue;
    }
    try {
      await queryRecrutamentoWrite(
        `UPDATE public.entrevistas_agendadas SET duracao_seg = $1 WHERE id = $2`,
        [r.duracaoSegundos, row.id],
      );
      ok++;
    } catch (e) {
      console.error(`[Entrevistas Duracao Checker] UPDATE falhou pra id ${row.id}:`, e);
      falhas++;
    }
  }

  console.log(
    `[Entrevistas Duracao Checker] Ciclo concluido: ${pendentes.length} verificadas, ${ok} atualizadas, ${falhas} falhas.`,
  );
}

export function iniciarEntrevistasDuracaoChecker(): void {
  if (timerRef) return;
  setTimeout(() => {
    executarCiclo().catch((err) => {
      console.error('[Entrevistas Duracao Checker] Erro no primeiro ciclo:', err);
    });
    timerRef = setInterval(() => {
      executarCiclo().catch((err) => {
        console.error('[Entrevistas Duracao Checker] Erro no ciclo:', err);
      });
    }, INTERVALO_MS);
  }, DELAY_INICIAL_MS);
}

export function pararEntrevistasDuracaoChecker(): void {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
  }
}
