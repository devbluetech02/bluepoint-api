import { query } from '@/lib/db';
import { enviarPushParaColaboradores } from '@/lib/push-colaborador';

/**
 * Dispara push pra todos os colaboradores ativos com permissão
 * `recrutamento:ver` ou `recrutamento:gerenciar` (= quem precisa
 * ser avisado quando um recrutador está mal-avaliado pela IA).
 *
 * Usado pelo fluxo de avaliação IA (avaliar-recrutador, cron) quando
 * o veredito repete "ruim" em ciclos consecutivos.
 *
 * Falha silenciosamente — nunca lança.
 */
export async function notificarGestoresRecrutamento(opts: {
  recrutador: string;
  score: number;
  feedbackGestor: string | null;
  avaliacaoId: string;
}): Promise<number> {
  try {
    const r = await query<{ id: number }>(
      `SELECT DISTINCT c.id
         FROM people.colaboradores c
         JOIN people.tipo_usuario_permissoes tp
           ON tp.tipo_usuario = c.tipo_usuario AND tp.concedido = true
         JOIN people.permissoes p ON p.id = tp.permissao_id
        WHERE c.status = 'ativo'
          AND p.codigo IN ('recrutamento:ver', 'recrutamento:gerenciar')`
    );
    const ids = r.rows.map((row) => row.id);
    if (ids.length === 0) return 0;

    const mensagem = opts.feedbackGestor && opts.feedbackGestor.length > 0
      ? opts.feedbackGestor
      : `O recrutador ${opts.recrutador} teve duas avaliações consecutivas abaixo do esperado (score atual: ${opts.score}/100). Recomendado conversar.`;

    await enviarPushParaColaboradores(ids, {
      titulo: `Atenção: performance de ${opts.recrutador}`,
      mensagem,
      severidade: 'atencao',
      data: {
        tipo: 'recrutador_avaliacao_ia',
        avaliacaoId: opts.avaliacaoId,
        recrutador: opts.recrutador,
        score: opts.score,
      },
    });

    return ids.length;
  } catch (e) {
    console.error('[notificar-gestor-recrutamento] falhou:', e);
    return 0;
  }
}
