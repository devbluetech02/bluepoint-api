import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateGestaoPessoasCache } from '@/lib/cache';
import { deletarArquivo } from '@/lib/storage';

interface Params {
  params: Promise<{ id: string; anexoId: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id, anexoId } = await params;
      const registroId = parseInt(id);
      const anexoIdNum = parseInt(anexoId);

      if (isNaN(registroId) || isNaN(anexoIdNum)) {
        return notFoundResponse('Anexo não encontrado');
      }

      const result = await query(
        `SELECT id, nome, caminho_storage
         FROM people.gestao_pessoas_anexos
         WHERE id = $1 AND gestao_pessoa_id = $2`,
        [anexoIdNum, registroId]
      );

      if (result.rows.length === 0) return notFoundResponse('Anexo não encontrado');

      const anexo = result.rows[0] as { id: number; nome: string; caminho_storage: string };

      await deletarArquivo(anexo.caminho_storage).catch(() => {});

      await query(
        `DELETE FROM people.gestao_pessoas_anexos WHERE id = $1`,
        [anexoIdNum]
      );

      await invalidateGestaoPessoasCache(registroId);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'excluir',
        modulo: 'gestao_pessoas',
        descricao: `Anexo "${anexo.nome}" removido do registro #${registroId}`,
        entidadeId: registroId,
        entidadeTipo: 'gestao_pessoas',
        dadosAnteriores: { anexoId: anexoIdNum, nome: anexo.nome },
      }));

      return successResponse({ message: 'Anexo excluído com sucesso' });
    } catch (error) {
      console.error('Erro ao excluir anexo:', error);
      return serverErrorResponse('Erro ao excluir anexo');
    }
  });
}
