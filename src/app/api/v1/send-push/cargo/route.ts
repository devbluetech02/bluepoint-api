import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { enviarPushParaCargo } from '@/lib/push-colaborador';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/send-push/cargo
 *
 * Envia push notification para todos os colaboradores ativos de um cargo.
 *
 * Body:
 *   cargoId    number   (obrigatório)
 *   titulo     string   (obrigatório)
 *   mensagem   string   (obrigatório)
 *   severidade 'critico' | 'atencao' | 'info'  (padrão: 'info')
 *   url        string   (opcional)
 */
export async function POST(request: NextRequest) {
  return withAdmin(request, async (req) => {
    try {
      const body = await req.json().catch(() => ({}));
      const { cargoId, titulo, mensagem, severidade, url } = body as {
        cargoId?: number;
        titulo?: string;
        mensagem?: string;
        severidade?: string;
        url?: string;
      };

      if (!cargoId || !titulo || !mensagem) {
        return errorResponse('Campos cargoId, titulo e mensagem são obrigatórios', 400);
      }

      // Verifica se o cargo existe
      const cargoResult = await query(
        `SELECT id, nome FROM people.cargos WHERE id = $1`,
        [cargoId],
      );
      if (cargoResult.rows.length === 0) {
        return errorResponse('Cargo não encontrado', 404);
      }
      const cargo = cargoResult.rows[0] as { id: number; nome: string };

      const total = await enviarPushParaCargo(cargoId, {
        titulo,
        mensagem,
        severidade: (severidade as 'critico' | 'atencao' | 'info') ?? 'info',
        url,
      });

      return successResponse({
        enviado: true,
        cargo: { id: cargo.id, nome: cargo.nome },
        destinatarios: total,
      });
    } catch (error) {
      console.error('[SendPushCargo] Erro:', error);
      return serverErrorResponse('Erro ao enviar push por cargo');
    }
  });
}
