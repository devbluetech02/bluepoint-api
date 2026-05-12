import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  createdResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { uploadDocumentoColaborador } from '@/lib/storage';

// =====================================================
// POST /api/public/atualizacao-cadastral/[token]/documento
//
// Upload imediato de um documento da solicitação de atualização
// cadastral. Page pública chama este endpoint assim que o
// colaborador escolhe o arquivo — sobe pro MinIO via
// `uploadDocumentoColaborador` (mesma convenção de path usada no
// resto do sistema) e devolve metadata. O POST final que confirma
// a solicitação envia só { tipoDocumentoId, storageKey, filename,
// contentType } — sem base64 no JSONB.
//
// Multipart/form-data:
//   - file:            o arquivo (PDF/JPG/PNG/WebP)
//   - tipoDocumentoId: ID em people.tipos_documento_colaborador
//
// Pública (sem JWT). Validado via token da solicitação.
// =====================================================

interface Params {
  params: Promise<{ token: string }>;
}

const TIPOS_MIME_ACEITOS = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const TAMANHO_MAX = 15 * 1024 * 1024; // 15 MB

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { token } = await params;

    // 1. Valida solicitação.
    const solRes = await query<{
      id: string;
      colaborador_id: number;
      tipos_documento_ids: number[] | null;
      status: string;
    }>(
      `SELECT id::text, colaborador_id, tipos_documento_ids, status
         FROM people.solicitacoes_atualizacao_cadastral
        WHERE token = $1
        LIMIT 1`,
      [token],
    );
    const solicitacao = solRes.rows[0];
    if (!solicitacao) {
      return errorResponse('Token inválido', 404);
    }
    if (solicitacao.status !== 'pendente' && solicitacao.status !== 'enviado') {
      return errorResponse('Esta solicitação já foi respondida', 403);
    }

    // 2. Multipart.
    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return errorResponse('Requisição deve ser multipart/form-data', 400);
    }
    const file = formData.get('file');
    const tipoIdRaw = formData.get('tipoDocumentoId');
    if (!(file instanceof File)) {
      return errorResponse('Campo "file" obrigatório', 400);
    }
    const tipoDocumentoId = Number(tipoIdRaw);
    if (!Number.isInteger(tipoDocumentoId) || tipoDocumentoId <= 0) {
      return errorResponse('tipoDocumentoId inválido', 400);
    }

    // 3. Tipo de documento existe e está entre os pedidos?
    const tiposPedidos = Array.isArray(solicitacao.tipos_documento_ids)
      ? solicitacao.tipos_documento_ids
      : [];
    if (!tiposPedidos.includes(tipoDocumentoId)) {
      return errorResponse(
        'Este tipo de documento não foi solicitado nesta atualização',
        400,
      );
    }
    const tipoRes = await query<{ codigo: string; nome_exibicao: string }>(
      `SELECT codigo, nome_exibicao
         FROM people.tipos_documento_colaborador
        WHERE id = $1
        LIMIT 1`,
      [tipoDocumentoId],
    );
    const tipo = tipoRes.rows[0];
    if (!tipo) {
      return errorResponse('Tipo de documento não encontrado', 404);
    }

    // 4. Validações de arquivo.
    if (file.size === 0) {
      return errorResponse('Arquivo vazio', 400);
    }
    if (file.size > TAMANHO_MAX) {
      return errorResponse(
        `Arquivo maior que o limite (${TAMANHO_MAX / 1024 / 1024} MB)`,
        413,
      );
    }
    const contentType = file.type || 'application/octet-stream';
    if (!TIPOS_MIME_ACEITOS.has(contentType.toLowerCase())) {
      return errorResponse(
        `Tipo de arquivo não suportado: ${contentType}`,
        415,
      );
    }

    // 5. Upload.
    const buffer = Buffer.from(await file.arrayBuffer());
    const nomeOriginal = file.name || `documento-${Date.now()}`;
    const { url, storageKey } = await uploadDocumentoColaborador(
      solicitacao.colaborador_id,
      tipo.codigo,
      buffer,
      contentType,
      nomeOriginal,
    );

    return createdResponse({
      tipoDocumentoId,
      storageKey,
      url,
      filename: nomeOriginal,
      contentType,
      tamanho: file.size,
    });
  } catch (error) {
    console.error('[atualizacao-cadastral/public/documento] erro:', error);
    return serverErrorResponse('Erro ao fazer upload do documento');
  }
}
