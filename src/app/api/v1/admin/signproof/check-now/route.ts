import { NextRequest } from 'next/server';
import { withGestor } from '@/lib/middleware';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { executarCicloSignProof } from '@/lib/signproof-status-checker';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

// =====================================================
// POST /api/v1/admin/signproof/check-now
// Força a execução imediata do ciclo de verificação SignProof (normalmente
// rodado a cada 5 min pelo cron em src/lib/signproof-status-checker.ts).
// Útil para testes manuais sem esperar o próximo tick do setInterval.
// =====================================================

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const resultado = await executarCicloSignProof();

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'criar',
        modulo: 'admissao',
        descricao: `SignProof check-now manual: ${resultado.documentos_verificados} verificado(s), ${resultado.documentos_atualizados} atualizado(s)`,
        dadosNovos: {
          documentos_verificados: resultado.documentos_verificados,
          documentos_atualizados: resultado.documentos_atualizados,
          atualizacoes: resultado.atualizacoes,
          erros: resultado.erros,
        },
      }));

      return successResponse({
        documentos_verificados: resultado.documentos_verificados,
        documentos_atualizados: resultado.documentos_atualizados,
        atualizacoes: resultado.atualizacoes,
        ...(resultado.erros.length > 0 ? { erros: resultado.erros } : {}),
      });
    } catch (error) {
      console.error('[SignProof check-now] Erro:', error);
      return serverErrorResponse('Erro ao executar verificação SignProof');
    }
  });
}
