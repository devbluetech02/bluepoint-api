import { NextRequest } from 'next/server';
import { successResponse, serverErrorResponse, errorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { PUSH_VISUAL, buildPushPayload, sendPush } from '@/lib/push-onesignal';

export async function POST(request: NextRequest) {
  return withAdmin(request, async (_req, user) => {
    try {
      const appId = process.env.ONESIGNAL_APP_ID;
      const apiKey = process.env.ONESIGNAL_REST_API_KEY;

      if (!appId || !apiKey) {
        return errorResponse('ONESIGNAL_APP_ID ou ONESIGNAL_REST_API_KEY nao configurados');
      }

      const body = await request.json().catch(() => ({}));
      const severidade: string = body.severidade || 'critico';
      const titulo: string = body.titulo || 'Teste BluePoint: 48 colaboradores ausentes!';
      const mensagem: string = body.mensagem || '48 de 120 colaboradores ausentes (40%). Impacto operacional provavel.';
      const enviarParaTodos: boolean = body.todos !== false;
      const externalIds: string[] | undefined = body.external_ids;

      const visual = PUSH_VISUAL[severidade] || PUSH_VISUAL.info;

      const payload = buildPushPayload({
        appId,
        headingText: titulo,
        contentText: mensagem,
        visual,
        data: {
          tipo: 'alerta_inteligente',
          categoria: 'teste',
          severidade,
        },
      });

      if (externalIds && externalIds.length > 0) {
        payload.include_aliases = { external_id: externalIds };
      } else if (enviarParaTodos) {
        payload.included_segments = ['All'];
      } else {
        payload.include_aliases = { external_id: [String(user.userId)] };
      }

      const result = await sendPush(apiKey, payload);

      return successResponse({
        enviado: result.ok,
        status: result.status,
        onesignal: result.body,
        payload_enviado: {
          severidade,
          titulo: visual.emoji + ' ' + titulo,
          mensagem,
          destino: externalIds ? ('external_ids: ' + externalIds.join(',')) : (enviarParaTodos ? 'Todos' : 'user:' + user.userId),
          cor: visual.cor,
          big_picture: visual.big_picture,
          large_icon: visual.large_icon,
        },
      });
    } catch (error) {
      console.error('Erro ao testar push:', error);
      return serverErrorResponse('Erro ao enviar push de teste');
    }
  });
}
