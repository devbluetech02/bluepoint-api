import { queryRecrutamento, queryRecrutamentoWrite } from './db';
import { avaliarAderencia } from './aderencia-ia';

// ─────────────────────────────────────────────────────────────────────────────
// Aderencia IA — cron interno
//
// Varre entrevistas com transcricao + duracao_seg setado e
// aderencia_ia_pct NULL. Pra cada uma busca o roteiro_entrevista
// correspondente (match por nome_vaga ILIKE) e chama LLM via
// avaliarAderencia(). Persiste pct + topicos.
//
// Mais caro que o checker de duracao (LLM), entao processa POUCAS
// por ciclo e roda em intervalo maior.
// ─────────────────────────────────────────────────────────────────────────────

const INTERVALO_MS = 10 * 60 * 1000; // 10 min
const DELAY_INICIAL_MS = 3 * 60 * 1000; // 3 min apos boot
const LIMITE_POR_CICLO = 5;

let timerRef: ReturnType<typeof setInterval> | null = null;

async function processarUma(row: {
  id: number;
  vaga: string | null;
  transcricao: string | null;
}): Promise<void> {
  const transcricao = row.transcricao ?? '';
  const vagaNome = (row.vaga ?? '').trim();

  // Busca roteiro por nome_vaga (ILIKE pra tolerar variacao de caixa).
  let roteiro = '';
  if (vagaNome) {
    const r = await queryRecrutamento<{ info_roteiro_text: string | null }>(
      `SELECT info_roteiro_text
         FROM public.roteiro_entrevista
        WHERE nome_vaga ILIKE $1
        ORDER BY data_atualizacao DESC NULLS LAST
        LIMIT 1`,
      [vagaNome],
    );
    roteiro = (r.rows[0]?.info_roteiro_text ?? '').trim();
  }

  if (!roteiro) {
    // Sem roteiro pra essa vaga — marca como NaN-equivalente
    // (pct=0, motivo no JSON). Nao deixa NULL pra nao reprocessar.
    await queryRecrutamentoWrite(
      `UPDATE public.entrevistas_agendadas
          SET aderencia_ia_pct = 0,
              aderencia_ia_avaliada_em = NOW(),
              aderencia_ia_topicos = $1::jsonb
        WHERE id = $2`,
      [
        JSON.stringify({
          abordados: [],
          ausentes: [],
          resumo: 'Sem roteiro cadastrado para esta vaga — aderência não avaliada.',
        }),
        row.id,
      ],
    );
    return;
  }

  const r = await avaliarAderencia({
    roteiro,
    transcricao,
    vaga: vagaNome,
  });

  if (!r.ok) {
    console.warn(`[Aderencia Checker] Entrevista ${row.id} falhou: ${r.motivo}`);
    // Nao escreve — fica NULL pra reprocessar no proximo ciclo.
    return;
  }

  await queryRecrutamentoWrite(
    `UPDATE public.entrevistas_agendadas
        SET aderencia_ia_pct = $1,
            aderencia_ia_avaliada_em = NOW(),
            aderencia_ia_topicos = $2::jsonb
      WHERE id = $3`,
    [r.pct, JSON.stringify(r.topicos), row.id],
  );
}

async function executarCiclo(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    return; // sem LLM: silencioso
  }

  let pendentes: { id: number; vaga: string | null; transcricao: string | null }[] = [];
  try {
    const r = await queryRecrutamento<{
      id: number;
      vaga: string | null;
      transcricao: string | null;
    }>(
      `SELECT id, vaga, COALESCE(transcricao, transcricao_raw) AS transcricao
         FROM public.entrevistas_agendadas
        WHERE COALESCE(transcricao, transcricao_raw) IS NOT NULL
          AND LENGTH(COALESCE(transcricao, transcricao_raw)) >= 200
          AND duracao_seg IS NOT NULL
          AND aderencia_ia_pct IS NULL
        ORDER BY id DESC
        LIMIT $1`,
      [LIMITE_POR_CICLO],
    );
    pendentes = r.rows;
  } catch (e) {
    console.error('[Aderencia Checker] Falha ao buscar pendentes:', e);
    return;
  }

  if (pendentes.length === 0) return;

  let ok = 0;
  let falhas = 0;
  for (const row of pendentes) {
    try {
      await processarUma(row);
      ok++;
    } catch (e) {
      falhas++;
      console.error(`[Aderencia Checker] Erro processando ${row.id}:`, e);
    }
  }
  console.log(
    `[Aderencia Checker] Ciclo concluido: ${pendentes.length} verificadas, ${ok} ok, ${falhas} erros.`,
  );
}

export function iniciarEntrevistasAderenciaChecker(): void {
  if (timerRef) return;
  setTimeout(() => {
    executarCiclo().catch((err) => {
      console.error('[Aderencia Checker] Erro no primeiro ciclo:', err);
    });
    timerRef = setInterval(() => {
      executarCiclo().catch((err) => {
        console.error('[Aderencia Checker] Erro no ciclo:', err);
      });
    }, INTERVALO_MS);
  }, DELAY_INICIAL_MS);
}

export function pararEntrevistasAderenciaChecker(): void {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
  }
}
