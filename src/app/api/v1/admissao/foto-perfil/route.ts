import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { fetchFormularioAdmissaoPorToken } from '@/lib/formulario-admissao';
import { uploadArquivo } from '@/lib/storage';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * POST /api/v1/admissao/foto-perfil?token=TOKEN
 *
 * Público — candidato faz upload de foto de perfil vinculado a uma solicitação de admissão.
 * A foto fica salva em MinIO em admissao/<solicitacaoId>/foto-perfil.<ext>
 * e a URL é persistida em solicitacoes_admissao.foto_perfil_url.
 * No momento da admissão (status → admitido) a URL é copiada para colaborador.foto_url.
 *
 * Body: multipart/form-data
 *   solicitacaoId  string (uuid)   obrigatório
 *   campoId        string (uuid)   obrigatório (id do campo no formulário)
 *   foto           File            obrigatório  JPEG | PNG | WebP, máx 5 MB
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
    const foto = formData.get('foto') as File | null;

    if (!solicitacaoId) {
      return errorResponse('Campo solicitacaoId é obrigatório', 400);
    }
    if (!foto) {
      return errorResponse('Campo foto é obrigatório', 400);
    }

    // Valida que a solicitação pertence a este formulário
    const solResult = await query(
      `SELECT id, status FROM people.solicitacoes_admissao
       WHERE id = $1 AND formulario_id = $2`,
      [solicitacaoId, formulario.id]
    );

    if (solResult.rows.length === 0) {
      return errorResponse('Solicitação não encontrada', 404);
    }

    const sol = solResult.rows[0] as { id: string; status: string };
    if (sol.status === 'admitido') {
      return errorResponse('Solicitação já concluída', 400);
    }

    // Valida tipo de arquivo
    if (!TIPOS_PERMITIDOS.has(foto.type)) {
      return errorResponse('Tipo de arquivo não permitido. Use JPEG, PNG ou WebP.', 400);
    }

    // Valida tamanho
    if (foto.size > MAX_FILE_SIZE) {
      return errorResponse('Arquivo muito grande. Máximo 5 MB.', 400);
    }

    // Determina extensão pelo content-type (normaliza sempre para .jpg se jpeg)
    let ext = 'jpg';
    if (foto.type === 'image/png') ext = 'png';
    else if (foto.type === 'image/webp') ext = 'webp';

    const storageKey = `admissao/${solicitacaoId}/foto-perfil.${ext}`;
    const buffer = Buffer.from(await foto.arrayBuffer());

    // Upload no MinIO (sobrescreve se já existir)
    const fotoUrl = await uploadArquivo(storageKey, buffer, foto.type);

    // Persiste a URL na solicitação
    await query(
      `UPDATE people.solicitacoes_admissao
          SET foto_perfil_url = $1, atualizado_em = NOW()
        WHERE id = $2`,
      [fotoUrl, solicitacaoId]
    );

    return successResponse({
      fotoUrl,
      mensagem: 'Foto enviada com sucesso',
    });
  } catch (error) {
    console.error('[foto-perfil] Erro ao fazer upload:', error);
    return serverErrorResponse('Erro ao fazer upload de foto de perfil');
  }
}
