import { queryRecrutamento, queryRecrutamentoWrite } from './db';
import { getVideoCreatedTime } from './drive-video';

// ─────────────────────────────────────────────────────────────────────────────
// Entrevistas — createdTime do video via Drive API
//
// Cron interno que varre periodicamente entrevistas_agendadas com video_id
// valido + video_created_at NULL e popula `video_created_at` consultando o
// Google Drive (createdTime).
//
// Diferente de data_entrevista (inicio agendado) e duracao_seg (duracao
// real), video_created_at e o momento em que a gravacao foi salva no
// Drive — proxy fiel pro FIM REAL da entrevista. Usado pra calcular
// tempo ocioso entre entrevistas consecutivas.
//
// Roda no boot do api (instrumentation.ts) — primeiro ciclo 120s apos
// start (deixa duracao-checker rodar primeiro) e depois a cada 5 min.
// Cada ciclo processa no maximo 30 entrevistas pra nao estourar rate
// limit do Drive.
// ─────────────────────────────────────────────────────────────────────────────

const INTERVALO_MS = 5 * 60 * 1000;
const DELAY_INICIAL_MS = 120 * 1000;
const LIMITE_POR_CICLO = 30;

let timerRef: ReturnType<typeof setInterval> | null = null;

async function executarCiclo(): Promise<void> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Sem credenciais — checker fica inativo silenciosamente.
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
          AND video_created_at IS NULL
        ORDER BY id DESC
        LIMIT $1`,
      [LIMITE_POR_CICLO],
    );
    pendentes = r.rows;
  } catch (e) {
    console.error(
      '[Entrevistas VideoCreated Checker] Falha ao buscar pendentes:',
      e,
    );
    return;
  }

  if (pendentes.length === 0) return;

  let ok = 0;
  let falhas = 0;
  for (const row of pendentes) {
    const r = await getVideoCreatedTime(row.video_id);
    if (!r.ok || !r.createdTime) {
      falhas++;
      continue;
    }
    try {
      await queryRecrutamentoWrite(
        `UPDATE public.entrevistas_agendadas SET video_created_at = $1 WHERE id = $2`,
        [r.createdTime.toISOString(), row.id],
      );
      ok++;
    } catch (e) {
      console.error(
        `[Entrevistas VideoCreated Checker] UPDATE falhou pra id ${row.id}:`,
        e,
      );
      falhas++;
    }
  }

  console.log(
    `[Entrevistas VideoCreated Checker] Ciclo concluido: ${pendentes.length} verificadas, ${ok} atualizadas, ${falhas} falhas.`,
  );
}

export function iniciarEntrevistasVideoCreatedChecker(): void {
  if (timerRef) return;
  setTimeout(() => {
    executarCiclo().catch((err) => {
      console.error(
        '[Entrevistas VideoCreated Checker] Erro no primeiro ciclo:',
        err,
      );
    });
    timerRef = setInterval(() => {
      executarCiclo().catch((err) => {
        console.error(
          '[Entrevistas VideoCreated Checker] Erro no ciclo:',
          err,
        );
      });
    }, INTERVALO_MS);
  }, DELAY_INICIAL_MS);
}

export function pararEntrevistasVideoCreatedChecker(): void {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
  }
}
