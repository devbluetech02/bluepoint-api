import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { fetchFormularioAdmissaoPorToken } from '@/lib/formulario-admissao';
import { uploadArquivo } from '@/lib/storage';

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const EXTENSOES_PERMITIDAS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx']);

/**
 * POST /api/v1/admissao/documentos?token=TOKEN
 * Público — candidato faz upload de documento vinculado a uma solicitação de admissão.
 * FormData: solicitacaoId (string uuid), tipoDocumentoId (number), arquivo (File)
 */
export async function POST(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return errorResponse('Token obrigatório', 401);
    }

    const formulario = await fetchFormularioAdmissaoPorToken(token);
    if (!formulario) {
      return errorResponse('Token inválido ou expirado', 403);
    }

    const formData = await request.formData();
    const solicitacaoId = formData.get('solicitacaoId') as string | null;
    const tipoDocumentoIdRaw = formData.get('tipoDocumentoId');
    const arquivo = formData.get('arquivo') as File | null;

    if (!solicitacaoId || !tipoDocumentoIdRaw || !arquivo) {
      return errorResponse('Campos solicitacaoId, tipoDocumentoId e arquivo são obrigatórios', 400);
    }

    const tipoDocumentoId = parseInt(String(tipoDocumentoIdRaw));
    if (isNaN(tipoDocumentoId)) {
      return errorResponse('tipoDocumentoId inválido', 400);
    }

    // Valida que a solicitação pertence a este formulário e está em status que aceita documentos
    const solicitacaoResult = await query(
      `SELECT id, status FROM people.solicitacoes_admissao
       WHERE id = $1 AND formulario_id = $2`,
      [solicitacaoId, formulario.id]
    );

    if (solicitacaoResult.rows.length === 0) {
      return errorResponse('Solicitação não encontrada', 404);
    }

    const solicitacao = solicitacaoResult.rows[0] as { id: string; status: string };
    if (solicitacao.status === 'admitido') {
      return errorResponse('Solicitação já concluída', 400);
    }

    // Valida tipo de documento
    const tipoResult = await query(
      `SELECT id, codigo FROM people.tipos_documento_colaborador
       WHERE id = $1 AND 'admissao' = ANY(categorias)`,
      [tipoDocumentoId]
    );

    if (tipoResult.rows.length === 0) {
      return errorResponse('Tipo de documento inválido para admissão', 400);
    }

    const codigoTipo = tipoResult.rows[0].codigo as string;

    if (arquivo.size > MAX_FILE_SIZE) {
      return errorResponse('Arquivo muito grande. Máximo 15 MB.', 400);
    }

    const ext = (arquivo.name.split('.').pop() || '').toLowerCase();
    if (!EXTENSOES_PERMITIDAS.has(ext)) {
      return errorResponse('Tipo de arquivo não permitido. Use: PDF, JPG, PNG, DOC ou DOCX.', 400);
    }

    const uniqueId = crypto.randomUUID();
    const storageKey = `admissao/${solicitacaoId}/${codigoTipo}/${uniqueId}.${ext}`;
    const buffer = Buffer.from(await arquivo.arrayBuffer());
    const contentType = arquivo.type || 'application/octet-stream';

    const url = await uploadArquivo(storageKey, buffer, contentType);

    const insertResult = await query(
      `INSERT INTO people.documentos_admissao
         (solicitacao_id, tipo_documento_id, nome, url, storage_key, tamanho)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, solicitacao_id, tipo_documento_id, nome, url, tamanho, criado_em`,
      [solicitacaoId, tipoDocumentoId, arquivo.name, url, storageKey, arquivo.size]
    );

    const row = insertResult.rows[0];

    // Se a solicitação está em aso_solicitado, transitar automaticamente para aso_recebido
    if (solicitacao.status === 'aso_solicitado') {
      await query(
        `UPDATE people.solicitacoes_admissao SET status = 'aso_recebido', atualizado_em = NOW() WHERE id = $1`,
        [solicitacaoId]
      );
    }

    return createdResponse({
      id: row.id,
      solicitacaoId: row.solicitacao_id,
      tipoDocumentoId: row.tipo_documento_id,
      nome: row.nome,
      url: row.url,
      tamanho: row.tamanho,
      criadoEm: row.criado_em,
    });
  } catch (error) {
    console.error('Erro ao fazer upload de documento de admissão:', error);
    return serverErrorResponse('Erro ao fazer upload de documento');
  }
}
