import { buildPushPayload, sendPush, PUSH_VISUAL } from '@/lib/push-onesignal';
import { PushColaboradorOpts } from '@/lib/push-colaborador';

/**
 * Envia push notification para um usuário provisório via OneSignal.
 *
 * Estratégia dupla:
 * 1. Se subscriptionId estiver disponível, usa include_subscription_ids
 *    → funciona mesmo após OneSignal.logout() (vinculado ao dispositivo, não ao login)
 * 2. Fallback para include_aliases com external_id "provisorio_<id>"
 *    → funciona apenas se o usuário ainda estiver logado no OneSignal
 *
 * Falha silenciosamente — nunca lança exceção.
 */
export async function enviarPushParaProvisorio(
  usuarioProvisorioId: number,
  opts: PushColaboradorOpts,
  subscriptionId?: string | null,
): Promise<void> {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) {
    console.warn('[Push Provisório] ONESIGNAL_APP_ID ou ONESIGNAL_REST_API_KEY não configurados');
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
    });

    if (subscriptionId) {
      // Targeting por dispositivo — funciona mesmo com usuário deslogado
      payload.include_subscription_ids = [subscriptionId];
    } else {
      // Fallback: targeting por external_id (requer usuário logado no OneSignal)
      payload.include_aliases = { external_id: [`provisorio_${usuarioProvisorioId}`] };
    }

    const result = await sendPush(apiKey, payload);
    if (!result.ok) {
      console.error('[Push Provisório] Erro ' + result.status + ':', JSON.stringify(result.body));
    }
  } catch (error) {
    console.error('[Push Provisório] Falha ao enviar push:', error);
  }
}
