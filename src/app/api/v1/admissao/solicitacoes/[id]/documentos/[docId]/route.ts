import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { deletarArquivo } from '@/lib/storage';
import { withGestor } from '@/lib/middleware';

interface Params {
  params: Promise<{ id: string; docId: string }>;
}

/**
 * DELETE /api/v1/admissao/solicitacoes/:id/documentos/:docId
 *
 * DP remove um documento da solicitação de pré-admissão. Limpa storage
 * (best-effort) e remove a linha da tabela documentos_admissao.
 *
 * Não bloqueia em status — DP pode limpar mesmo após admissão (caso o
 * documento esteja errado e o colaborador já existir, o cleanup do lado
 * do colaborador é separado em documentos_colaborador).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async () => {
    try {
      const { id, docId } = await params;

      const docResult = await query<{
        id: string;
        storage_key: string | null;
      }>(
        `SELECT id, storage_key
           FROM people.documentos_admissao
          WHERE id = $1 AND solicitacao_id = $2`,
        [docId, id],
      );

      if (docResult.rows.length === 0) {
        return notFoundResponse('Documento não encontrado nesta solicitação');
      }
      const doc = docResult.rows[0];

      // Storage cleanup é best-effort: se falhar, ainda removemos do banco
      // pra não deixar referência órfã na UI.
      if (doc.storage_key) {
        try {
          await deletarArquivo(doc.storage_key);
        } catch (err) {
          console.warn('[admissao/documentos:DELETE] storage cleanup falhou', {
            solicitacaoId: id,
            documentoId:   docId,
            storageKey:    doc.storage_key,
            error:         err instanceof Error ? err.message : String(err),
          });
        }
      }

      const delResult = await query(
        `DELETE FROM people.documentos_admissao WHERE id = $1 AND solicitacao_id = $2`,
        [docId, id],
      );

      if (delResult.rowCount === 0) {
        return errorResponse('Falha ao remover documento', 500);
      }

      return successResponse({ id: docId, removido: true });
    } catch (error) {
      console.error('[admissao/documentos:DELETE] erro:', error);
      return serverErrorResponse('Erro ao remover documento');
    }
  });
}
