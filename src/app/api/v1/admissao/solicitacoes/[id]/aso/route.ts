import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';
import { fetchFormularioAdmissaoPorToken } from '@/lib/formulario-admissao';
import { uploadArquivo } from '@/lib/storage';
import { criarNotificacao } from '@/lib/notificacoes';
import { enviarPushParaColaboradores, enviarPushParaCargoNome } from '@/lib/push-colaborador';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const EXTENSOES_PERMITIDAS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/admissao/solicitacoes/:id/aso
 *
 * Anexa o ASO (Atestado de Saúde Ocupacional) a uma pré-admissão.
 * Transita o status automaticamente para 'aso_recebido'.
 *
 * Autenticação (uma das duas):
 *   - Query param ?token=TOKEN  → candidato via token público do formulário
 *   - Header Authorization JWT  → admin/gestor via withAdmissao
 *
 * Body: multipart/form-data
 *   arquivo  File  obrigatório  PDF, JPG, PNG ou WEBP, máx 15 MB
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get('token');

  // ── Resolve identidade ──────────────────────────────────────────────────────
  // Candidato via token público OU admin/gestor via JWT
  if (token) {
    return handleComToken(request, id, token);
  }

  return withAdmissao(request, async () => {
    return handleUpload(request, id, /* autenticadoPorJwt */ true);
  });
}

async function handleComToken(request: NextRequest, solicitacaoId: string, token: string) {
  const formulario = await fetchFormularioAdmissaoPorToken(token);
  if (!formulario) {
    return errorResponse('Token inválido ou expirado', 403);
  }

  // Garante que a solicitação pertence a este formulário
  const check = await query(
    `SELECT id FROM people.solicitacoes_admissao WHERE id = $1 AND formulario_id = $2`,
    [solicitacaoId, formulario.id]
  );
  if (check.rows.length === 0) {
    return notFoundResponse('Solicitação não encontrada');
  }

  return handleUpload(request, solicitacaoId, false);
}

async function handleUpload(request: NextRequest, solicitacaoId: string, byAdmin: boolean) {
  try {
    // ── Busca solicitação ─────────────────────────────────────────────────────
    const solResult = await query<{
      id: string;
      status: string;
      usuario_provisorio_id: number | null;
      onesignal_subscription_id: string | null;
    }>(
      `SELECT id, status, usuario_provisorio_id, onesignal_subscription_id FROM people.solicitacoes_admissao WHERE id = $1`,
      [solicitacaoId]
    );

    if (solResult.rows.length === 0) {
      return notFoundResponse('Solicitação não encontrada');
    }

    const sol = solResult.rows[0];

    if (sol.status === 'admitido') {
      return errorResponse('Admissão já concluída — não é possível anexar documentos', 400);
    }

    if (sol.status === 'aso_recebido') {
      return errorResponse('ASO já foi recebido para esta solicitação', 409);
    }

    // ── Valida arquivo ────────────────────────────────────────────────────────
    const formData = await request.formData();
    const arquivo = formData.get('arquivo') as File | null;

    if (!arquivo) {
      return errorResponse('"arquivo" é obrigatório', 400);
    }

    if (arquivo.size > MAX_FILE_SIZE) {
      return errorResponse('Arquivo muito grande. Máximo 15 MB.', 400);
    }

    const ext = (arquivo.name.split('.').pop() || '').toLowerCase();
    if (!EXTENSOES_PERMITIDAS.has(ext)) {
      return errorResponse('Tipo de arquivo não permitido. Use: PDF, JPG, PNG ou WEBP.', 400);
    }

    // ── Resolve tipo de documento ASO ─────────────────────────────────────────
    const tipoResult = await query<{ id: number }>(
      `SELECT id FROM people.tipos_documento_colaborador WHERE codigo = 'aso' LIMIT 1`
    );
    if (tipoResult.rows.length === 0) {
      return serverErrorResponse('Tipo de documento ASO não configurado');
    }
    const tipoDocumentoId = tipoResult.rows[0].id;

    // ── Upload MinIO ──────────────────────────────────────────────────────────
    const uniqueId = crypto.randomUUID();
    const storageKey = `admissao/${solicitacaoId}/aso/${uniqueId}.${ext}`;
    const buffer = Buffer.from(await arquivo.arrayBuffer());
    const contentType = arquivo.type || 'application/octet-stream';
    const url = await uploadArquivo(storageKey, buffer, contentType);

    // ── Persiste documento + transita status (transação) ─────────────────────
    const insertResult = await query<{
      id: number;
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
      [solicitacaoId, tipoDocumentoId, arquivo.name, url, storageKey, arquivo.size]
    );

    await query(
      `UPDATE people.solicitacoes_admissao
       SET status = 'aso_recebido', atualizado_em = NOW()
       WHERE id = $1`,
      [solicitacaoId]
    );

    // ── Push para o candidato ─────────────────────────────────────────────────
    if (sol.usuario_provisorio_id) {
      enviarPushParaProvisorio(
        sol.usuario_provisorio_id,
        {
          titulo:     'ASO recebido com sucesso',
          mensagem:   'Seu ASO foi enviado. Em breve você terá uma atualização sobre sua admissão.',
          severidade: 'info',
          data:       { tipo: 'aso_recebido', solicitacaoId },
          url:        '/pre-admissao',
        },
        sol.onesignal_subscription_id,
      ).catch(err => console.error('[ASO Upload] Erro ao enviar push candidato:', err));
    }

    // ── Notifica admins/gestores ──────────────────────────────────────────────
    const adminResult = await query<{ id: number }>(
      `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
    );
    const adminIds = adminResult.rows.map(r => r.id);

    const origemLabel = byAdmin ? 'pelo DP' : 'pelo candidato';
    const titulo = 'ASO recebido';
    const mensagem = `O ASO de uma pré-admissão foi enviado ${origemLabel}. Acesse para revisar.`;

    for (const adminId of adminIds) {
      criarNotificacao({
        usuarioId: adminId,
        tipo: 'solicitacao',
        titulo,
        mensagem,
        link: '/pre-admissao',
        metadados: { acao: 'aso_recebido', solicitacaoId, byAdmin },
      }).catch(err => console.error('[ASO Upload] Erro ao criar notificação:', err));
    }

    if (adminIds.length > 0) {
      enviarPushParaColaboradores(adminIds, {
        titulo,
        mensagem,
        severidade: 'info',
        data: { tipo: 'aso_recebido', solicitacaoId },
        url: '/pre-admissao',
      }).catch(err => console.error('[ASO Upload] Erro ao enviar push:', err));
    }

    enviarPushParaCargoNome('Administrador', {
      titulo,
      mensagem,
      severidade: 'info',
      data: { tipo: 'aso_recebido', solicitacaoId },
      url: '/pre-admissao',
    }).catch(err => console.error('[ASO Upload] Erro ao enviar push cargo Administrador:', err));

    const row = insertResult.rows[0];
    return createdResponse({
      id: row.id,
      solicitacaoId: row.solicitacao_id,
      tipoDocumentoId: row.tipo_documento_id,
      nome: row.nome,
      url: row.url,
      tamanho: row.tamanho,
      criadoEm: row.criado_em,
      statusAtualizado: 'aso_recebido',
    });
  } catch (error) {
    console.error('[ASO Upload] Erro:', error);
    return serverErrorResponse('Erro ao anexar ASO');
  }
}
