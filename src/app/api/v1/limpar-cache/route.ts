import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { invalidateAllCache } from '@/lib/cache';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

/**
 * POST /api/v1/limpar-cache
 * Limpa TODO o cache do Redis
 * Útil após alterações diretas no banco de dados
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      // Invalidar TODO o cache
      await invalidateAllCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'cache',
        descricao: 'Cache do Redis completamente limpo',
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { scope: 'all' },
      });
      
      return NextResponse.json({
        success: true,
        data: {
          message: 'Cache completamente limpo com sucesso',
          scope: 'all',
        },
      });
    } catch (error) {
      console.error('Erro ao limpar cache:', error);
      return NextResponse.json({
        success: false,
        error: 'Erro ao limpar cache',
      }, { status: 500 });
    }
  });
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
