import { NextRequest } from 'next/server';
import { successResponse, serverErrorResponse, paginatedSuccessResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { listarAlertasInteligentes } from '@/lib/ai-analytics';
import { getPaginationParams } from '@/lib/api-response';

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const params = req.nextUrl.searchParams;
      const { pagina, limite, offset } = getPaginationParams(params);

      const empresaId = params.get('empresaId');
      const categoria = params.get('categoria');
      const severidade = params.get('severidade');
      const apenasNaoLidos = params.get('apenasNaoLidos') === 'true';

      const resultado = await listarAlertasInteligentes({
        empresaId: empresaId ? parseInt(empresaId) : undefined,
        categoria: categoria || undefined,
        severidade: severidade || undefined,
        apenasNaoLidos,
        limite,
        offset,
      });

      return paginatedSuccessResponse(
        resultado.alertas,
        resultado.total,
        pagina,
        limite
      );
    } catch (error) {
      console.error('Erro ao listar alertas inteligentes:', error);
      return serverErrorResponse('Erro ao listar alertas inteligentes');
    }
  });
}
