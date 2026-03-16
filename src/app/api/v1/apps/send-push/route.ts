import { NextRequest, NextResponse } from 'next/server';
import { withRole } from '@/lib/middleware';
import { enviarPushNovaVersao } from '@/lib/push-onesignal';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withRole(request, ['admin'], async (req) => {
    try {
      const body = await req.json();
      const { nome, versao } = body as { nome?: string; versao?: string };

      if (!nome || !versao) {
        return NextResponse.json(
          {
            success: false,
            error: 'Campos nome e versao são obrigatórios',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        );
      }

      const downloadUrl = `${process.env.BASE_URL || ''}/api/v1/apps/${nome}/download`;

      await enviarPushNovaVersao(nome, versao, downloadUrl);

      return NextResponse.json(
        {
          success: true,
          message: 'Notificação de nova versão enviada (se app elegível e credenciais OneSignal configuradas).',
          data: {
            nome,
            versao,
            urlDownload: downloadUrl,
          },
        },
        { status: 200 },
      );
    } catch (error) {
      console.error('[SEND_PUSH_APP] Erro ao enviar push manual:', error);
      return NextResponse.json(
        {
          success: false,
          error: 'Erro ao enviar notificação de nova versão',
          code: 'INTERNAL_ERROR',
        },
        { status: 500 },
      );
    }
  });
}

