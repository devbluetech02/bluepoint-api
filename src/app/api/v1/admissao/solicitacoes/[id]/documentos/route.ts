import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { uploadArquivo } from '@/lib/storage';
import { withGestor } from '@/lib/middleware';

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const EXTENSOES_PERMITIDAS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx']);

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/admissao/solicitacoes/:id/documentos
 *
 * DP anexa um documento à solicitação de pré-admissão. Aceita múltiplos
 * documentos do mesmo tipo (ex.: DP envia 2 fotos de CNH).
 *
 * Diferença em relação a POST /admissao/documentos (público, candidato):
 *   - autenticação via JWT de gestor (não token de formulário público);
 *   - permite qualquer status que não seja terminal-falha;
 *   - NÃO transita status (DP não está respondendo a um pedido de ASO).
 *
 * FormData: tipoDocumentoId (number), arquivo (File)
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req) => {
    try {
      const { id } = await params;

      const formData = await req.formData();
      const tipoDocumentoIdRaw = formData.get('tipoDocumentoId');
      const arquivo = formData.get('arquivo') as File | null;

      if (!tipoDocumentoIdRaw || !arquivo) {
        return errorResponse('Campos tipoDocumentoId e arquivo são obrigatórios', 400);
      }

      const tipoDocumentoId = parseInt(String(tipoDocumentoIdRaw));
      if (isNaN(tipoDocumentoId)) {
        return errorResponse('tipoDocumentoId inválido', 400);
      }

      // Valida solicitação
      const solicitacaoResult = await query<{ id: string; status: string }>(
        `SELECT id, status FROM people.solicitacoes_admissao WHERE id = $1`,
        [id],
      );
      if (solicitacaoResult.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }
      const solicitacao = solicitacaoResult.rows[0];
      if (solicitacao.status === 'admitido') {
        return errorResponse('Solicitação já concluída', 400);
      }
      if (solicitacao.status === 'cancelado' || solicitacao.status === 'rejeitado') {
        return errorResponse('Solicitação encerrada (cancelada ou rejeitada)', 400);
      }

      // Valida tipo de documento
      const tipoResult = await query<{ id: number; codigo: string }>(
        `SELECT id, codigo FROM people.tipos_documento_colaborador
         WHERE id = $1 AND 'admissao' = ANY(categorias)`,
        [tipoDocumentoId],
      );
      if (tipoResult.rows.length === 0) {
        return errorResponse('Tipo de documento inválido para admissão', 400);
      }
      const codigoTipo = tipoResult.rows[0].codigo;

      if (arquivo.size > MAX_FILE_SIZE) {
        return errorResponse('Arquivo muito grande. Máximo 15 MB.', 400);
      }
      const ext = (arquivo.name.split('.').pop() || '').toLowerCase();
      if (!EXTENSOES_PERMITIDAS.has(ext)) {
        return errorResponse('Tipo de arquivo não permitido. Use: PDF, JPG, PNG, DOC ou DOCX.', 400);
      }

      const uniqueId = crypto.randomUUID();
      const storageKey = `admissao/${id}/${codigoTipo}/${uniqueId}.${ext}`;
      const buffer = Buffer.from(await arquivo.arrayBuffer());
      const contentType = arquivo.type || 'application/octet-stream';

      const url = await uploadArquivo(storageKey, buffer, contentType);

      const insertResult = await query<{
        id: string;
        solicitacao_id: string;
        tipo_documento_id: number;
        nome: string;
        url: string;
        tamanho: number;
        criado_em: string;
      }>(
        `INSERT INTO people.documentos_admissao
           (solicitacao_id, tipo_documento_id, nome, url, storage_key, tamanho)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, solicitacao_id, tipo_documento_id, nome, url, tamanho, criado_em`,
        [id, tipoDocumentoId, arquivo.name, url, storageKey, arquivo.size],
      );

      const row = insertResult.rows[0];
      return createdResponse({
        id:              row.id,
        solicitacaoId:   row.solicitacao_id,
        tipoDocumentoId: row.tipo_documento_id,
        codigo:          codigoTipo,
        nome:            row.nome,
        url:             row.url,
        tamanho:         row.tamanho,
        criadoEm:        row.criado_em,
      });
    } catch (error) {
      console.error('[admissao/documentos:POST] erro:', error);
      return serverErrorResponse('Erro ao anexar documento');
    }
  });
}
