import { buildPushPayload, sendPush, PUSH_VISUAL } from '@/lib/push-onesignal';
import { query } from '@/lib/db';

export type PushSeveridade = 'critico' | 'atencao' | 'info';

export interface PushColaboradorOpts {
  titulo: string;
  mensagem: string;
  severidade?: PushSeveridade;
  data?: Record<string, unknown>;
  url?: string;
  fotoUrl?: string;
}

/**
 * Envia push notification para um colaborador específico via OneSignal.
 *
 * O OneSignal identifica cada usuário pelo `external_id` que o app mobile registra
 * no login (setExternalUserId). Usamos String(colaboradorId) como external_id,
 * seguindo o mesmo padrão já adotado nos alertas periódicos para admins.
 *
 * A notificação chega mesmo com o app fechado (background push).
 * Falha silenciosamente — nunca lança exceção.
 */
export async function enviarPushParaColaborador(
  colaboradorId: number,
  opts: PushColaboradorOpts,
): Promise<void> {
  return enviarPushParaColaboradores([colaboradorId], opts);
}

/**
 * Envia push notification para múltiplos colaboradores num único request ao OneSignal.
 * Mais eficiente do que chamar enviarPushParaColaborador em loop.
 */
/**
 * Envia push notification para todos os colaboradores ativos de um cargo (por ID).
 * Retorna o número de destinatários encontrados.
 */
export async function enviarPushParaCargo(
  cargoId: number,
  opts: PushColaboradorOpts,
): Promise<number> {
  const result = await query(
    `SELECT id FROM people.colaboradores WHERE cargo_id = $1 AND status = 'ativo'`,
    [cargoId],
  );
  const ids: number[] = result.rows.map((r) => (r as { id: number }).id);
  if (ids.length === 0) return 0;
  await enviarPushParaColaboradores(ids, opts);
  return ids.length;
}

/**
 * Envia push notification para todos os colaboradores ativos de um cargo (por nome).
 * Útil para cargos fixos do sistema como "Administrador".
 * Falha silenciosamente se o cargo não existir.
 */
export async function enviarPushParaCargoNome(
  cargoNome: string,
  opts: PushColaboradorOpts,
): Promise<void> {
  const result = await query(
    `SELECT c.id
       FROM people.colaboradores c
       JOIN people.cargos cg ON cg.id = c.cargo_id
      WHERE LOWER(cg.nome) = LOWER($1) AND c.status = 'ativo'`,
    [cargoNome],
  );
  const ids: number[] = result.rows.map((r) => (r as { id: number }).id);
  if (ids.length === 0) return;
  await enviarPushParaColaboradores(ids, opts);
}

export async function enviarPushParaColaboradores(
  colaboradorIds: number[],
  opts: PushColaboradorOpts,
): Promise<void> {
  if (colaboradorIds.length === 0) return;

  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) {
    console.warn('[Push] ONESIGNAL_APP_ID ou ONESIGNAL_REST_API_KEY não configurados');
    return;
  }

  try {
    const visual = PUSH_VISUAL[opts.severidade ?? 'info'];
    const payload = buildPushPayload({
      appId,
      headingText: opts.titulo,
      contentText: opts.mensagem,
      visual,
      data: opts.data,
      url: opts.url,
      fotoUrl: opts.fotoUrl,
    });
    // include_aliases com external_id é o mecanismo do OneSignal para targeting
    // de usuários específicos. O app precisa chamar OneSignal.login(String(colaboradorId))
    // (ou setExternalUserId em versões antigas do SDK) ao autenticar.
    payload.include_aliases = { external_id: colaboradorIds.map((id) => `people_${id}`) };

    const result = await sendPush(apiKey, payload);
    if (!result.ok) {
      console.error('[Push] Erro ' + result.status + ':', JSON.stringify(result.body));
    }
  } catch (error) {
    console.error('[Push] Falha ao enviar push:', error);
  }
}
