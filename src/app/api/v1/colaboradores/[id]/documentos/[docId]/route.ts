import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  serverErrorResponse,
  forbiddenResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { deletarDocumentoColaborador } from '@/lib/storage';
import { invalidateDocumentosColaboradorCache } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';

interface Params {
  params: Promise<{ id: string; docId: string }>;
}

/**
 * DELETE /api/v1/colaboradores/:id/documentos/:docId
 * Remove o documento do colaborador (MinIO + registro no banco).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id, docId } = await params;
      const colaboradorId = parseInt(id);
      const documentoId = parseInt(docId);

      if (isNaN(colaboradorId) || isNaN(documentoId)) {
        return notFoundResponse('Recurso não encontrado');
      }

      const acesso = await asseguraAcessoColaborador(user, colaboradorId);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      const docResult = await query(
        `SELECT d.id, d.colaborador_id, d.tipo, d.nome, d.storage_key, c.nome AS colaborador_nome
         FROM people.documentos_colaborador d
         JOIN people.colaboradores c ON c.id = d.colaborador_id
         WHERE d.id = $1 AND d.colaborador_id = $2`,
        [documentoId, colaboradorId]
      );

      if (docResult.rows.length === 0) {
        return notFoundResponse('Documento não encontrado');
      }

      const doc = docResult.rows[0];

      if (doc.storage_key) {
        try {
          await deletarDocumentoColaborador(doc.storage_key);
        } catch (e) {
          console.warn('Erro ao remover arquivo do MinIO (pode já ter sido removido):', e);
        }
      }

      await query(
        `DELETE FROM people.documentos_colaborador WHERE id = $1 AND colaborador_id = $2`,
        [documentoId, colaboradorId]
      );

      await invalidateDocumentosColaboradorCache(colaboradorId);

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'excluir',
          modulo: 'colaboradores',
          descricao: `Documento ${doc.tipo} removido do colaborador ${doc.colaborador_nome}`,
          entidadeId: colaboradorId,
          entidadeTipo: 'colaborador',
          dadosAnteriores: { documentoId, tipo: doc.tipo, nome: doc.nome },
        })
      );

      return successResponse({
        mensagem: 'Documento removido com sucesso',
        documentoId,
        colaboradorId,
      });
    } catch (error) {
      console.error('Erro ao remover documento:', error);
      return serverErrorResponse('Erro ao remover documento');
    }
  });
}
