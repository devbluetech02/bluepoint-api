import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withGestor } from '@/lib/middleware';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';

// POST /api/v1/whatsapp/enviar
//
// Endpoint genérico para enviar mensagem de texto pelo WhatsApp
// via Evolution API. Restrito a gestores+.

const schema = z.object({
  telefone: z.string().min(10).max(20),
  mensagem: z.string().min(1).max(5000),
});

export async function POST(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const body = await req.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }
      const { telefone, mensagem } = parsed.data;
      const numero = telefone.replace(/\D/g, '');
      if (numero.length < 10) {
        return errorResponse('Telefone inválido', 400);
      }
      const result = await enviarMensagemWhatsApp(numero, mensagem);
      if (!result.ok) {
        return errorResponse(`Falha ao enviar WhatsApp: ${result.erro ?? 'desconhecido'}`, 502);
      }
      return successResponse({ enviado: true });
    } catch (error) {
      console.error('[whatsapp/enviar] erro:', error);
      return serverErrorResponse('Erro ao enviar mensagem WhatsApp');
    }
  });
}
