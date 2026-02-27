import { NextRequest } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
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

      return successResponse({
        alertas: resultado.alertas,
        paginacao: {
          total: resultado.total,
          pagina,
          limite,
          totalPaginas: Math.ceil(resultado.total / limite),
        },
      });
    } catch (error) {
      console.error('Erro ao listar alertas inteligentes:', error);
      return serverErrorResponse('Erro ao listar alertas inteligentes');
    }
  });
}
