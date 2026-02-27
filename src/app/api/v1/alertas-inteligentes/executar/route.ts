import { NextRequest } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { executarAnaliseManual } from '@/lib/alertas-periodicos';
import { listarAlertasInteligentes } from '@/lib/ai-analytics';

export async function POST(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      await executarAnaliseManual();

      const resultado = await listarAlertasInteligentes({ limite: 20 });

      return successResponse({
        mensagem: 'Analise executada com sucesso',
        alertasRecentes: resultado.alertas,
        totalAlertas: resultado.total,
        analisadoEm: new Date().toISOString(),
        iaDisponivel: !!process.env.GEMINI_API_KEY,
      });
    } catch (error) {
      console.error('Erro ao executar analise inteligente:', error);
      return serverErrorResponse('Erro ao executar analise inteligente');
    }
  });
}
