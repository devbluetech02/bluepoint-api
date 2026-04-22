import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, successResponse, validationErrorResponse } from '@/lib/api-response';
import { fetchFormularioAdmissaoPorToken, mapCamposParaApi } from '@/lib/formulario-admissao';
import { extractTokenFromHeader, verifyToken } from '@/lib/auth';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';
import { enviarPushParaCargoNome } from '@/lib/push-colaborador';

// Qualidade mínima exigida para biometria em campos face_capture obrigatórios
const QUALIDADE_MINIMA_BIOMETRIA = 0.4;

const enviarAdmissaoSchema = z.object({
  dados:               z.record(z.string(), z.unknown()),
  solicitacaoId:       z.string().uuid().optional().nullable(),     // presente no reenvio após correção
  onesignalSubscriptionId: z.string().max(255).optional().nullable(), // subscription_id do dispositivo
});

/**
 * POST /api/v1/admissao/enviar?token=TOKEN
 *
 * Primeiro envio: cria uma nova solicitação de admissão (ou transiciona a stub
 * 'nao_acessado' pré-criada quando há vínculo com usuario_provisorio).
 * Reenvio após correção: passa solicitacaoId no body — a solicitação existente
 * restaura o status que tinha antes da correção (coluna status_antes_correcao),
 * limpa pendências e atualiza os dados.
 *
 * Se vier Authorization: Bearer <jwt_provisorio>, vincula o usuario_provisorio_id
 * para permitir push notifications em mudanças de status.
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

    const body = await request.json().catch(() => null);
    if (!body) {
      return errorResponse('Body inválido ou malformado', 400);
    }

    const validation = validateBody(enviarAdmissaoSchema, body);
    if (!validation.success) {
      return validationErrorResponse(validation.errors);
    }

    const { dados, solicitacaoId, onesignalSubscriptionId } = validation.data;

    // Extrai usuário provisório do JWT, se presente
    let usuarioProvisorioId: number | null = null;
    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      const jwtToken = extractTokenFromHeader(authHeader);
      if (jwtToken) {
        const payload = verifyToken(jwtToken);
        if (payload?.tipo === 'provisorio') {
          usuarioProvisorioId = payload.userId;
        }
      }
    }

    // Reenvio após correção
    if (solicitacaoId) {
      const existing = await query(
        `SELECT id, status FROM people.solicitacoes_admissao WHERE id = $1`,
        [solicitacaoId]
      );

      if (existing.rows.length === 0) {
        return errorResponse('Solicitação não encontrada', 404);
      }

      if (existing.rows[0].status !== 'correcao_solicitada') {
        return errorResponse(
          'Só é possível reenviar uma solicitação com status "correcao_solicitada"',
          409
        );
      }

      // Valida campos photo / face_capture obrigatórios antes de aceitar o reenvio
      const validacaoMedia = await validarCamposMediaObrigatorios(solicitacaoId, formulario.campos);
      if (validacaoMedia) {
        return errorResponse(validacaoMedia, 422);
      }

      // Restaura status_antes_correcao (capturado quando RH pediu correção). Fallback
      // 'aguardando_rh' cobre o fluxo legado em que a coluna ainda está NULL.
      const updated = await query(
        `UPDATE people.solicitacoes_admissao
            SET dados                     = $1::jsonb,
                status                    = COALESCE(status_antes_correcao, 'aguardando_rh'),
                status_antes_correcao     = NULL,
                pendencias_correcao       = NULL,
                atualizado_em             = NOW(),
                onesignal_subscription_id = COALESCE($3, onesignal_subscription_id)
          WHERE id = $2
          RETURNING id, status, atualizado_em`,
        [JSON.stringify(dados), solicitacaoId, onesignalSubscriptionId ?? null]
      );

      const row = updated.rows[0];

      enviarPushParaCargoNome('Administrador', {
        titulo:     'Pré-admissão reenviada',
        mensagem:   'O candidato corrigiu e reenviou a solicitação de admissão.',
        severidade: 'atencao',
        data:       { tipo: 'admissao_status', solicitacaoId: row.id, status: row.status },
        url:        '/pre-admissao',
      }).catch(console.error);

      return successResponse({
        id:           row.id,
        status:       row.status,
        atualizadoEm: row.atualizado_em,
      });
    }

    // Primeiro envio — se houver stub 'nao_acessado' pro provisório (criado automaticamente
    // junto com o acesso em POST /usuarios-provisorios), transiciona ele para 'aguardando_rh'.
    // Caso contrário (ex.: fluxo antigo sem stub, ou envio sem JWT de provisório), cria uma nova.
    type EnvioRow = { id: string; status: string; criado_em: string };
    let row: EnvioRow;
    if (usuarioProvisorioId) {
      const stub = await query<EnvioRow>(
        `UPDATE people.solicitacoes_admissao
            SET status                    = 'aguardando_rh',
                formulario_id             = $1,
                dados                     = $2::jsonb,
                onesignal_subscription_id = COALESCE($3, onesignal_subscription_id),
                atualizado_em             = NOW()
          WHERE usuario_provisorio_id = $4
            AND status = 'nao_acessado'
          RETURNING id, status, criado_em`,
        [formulario.id, JSON.stringify(dados), onesignalSubscriptionId ?? null, usuarioProvisorioId]
      );
      if (stub.rows.length > 0) {
        row = stub.rows[0];
      } else {
        const result = await query<EnvioRow>(
          `INSERT INTO people.solicitacoes_admissao (formulario_id, status, dados, usuario_provisorio_id, onesignal_subscription_id)
           VALUES ($1, 'aguardando_rh', $2::jsonb, $3, $4)
           RETURNING id, status, criado_em`,
          [formulario.id, JSON.stringify(dados), usuarioProvisorioId, onesignalSubscriptionId ?? null]
        );
        row = result.rows[0];
      }
    } else {
      const result = await query<EnvioRow>(
        `INSERT INTO people.solicitacoes_admissao (formulario_id, status, dados, usuario_provisorio_id, onesignal_subscription_id)
         VALUES ($1, 'aguardando_rh', $2::jsonb, $3, $4)
         RETURNING id, status, criado_em`,
        [formulario.id, JSON.stringify(dados), null, onesignalSubscriptionId ?? null]
      );
      row = result.rows[0];
    }

    enviarPushParaCargoNome('Administrador', {
      titulo:     'Nova pré-admissão recebida',
      mensagem:   'Uma nova solicitação de admissão foi enviada e aguarda análise.',
      severidade: 'atencao',
      data:       { tipo: 'admissao_status', solicitacaoId: row.id, status: row.status },
      url:        '/pre-admissao',
    }).catch(console.error);

    return createdResponse({
      id:       row.id,
      status:   row.status,
      criadoEm: row.criado_em,
    });
  } catch (error) {
    console.error('Erro ao enviar formulário de admissão:', error);
    return serverErrorResponse('Erro ao enviar formulário de admissão');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação de campos photo / face_capture obrigatórios no reenvio
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica se todos os campos obrigatórios de tipo 'photo' e 'face_capture'
 * já foram enviados para a solicitação.
 *
 * Retorna uma string de erro se alguma validação falhar, ou null se tudo OK.
 */
async function validarCamposMediaObrigatorios(
  solicitacaoId: string,
  camposRaw: unknown
): Promise<string | null> {
  const campos = mapCamposParaApi(camposRaw, true); // somente campos ativos

  const temPhotoObrigatorio   = campos.some(c => c.tipo === 'photo'        && c.obrigatorio);
  const temFaceCaptObrigatorio = campos.some(c => c.tipo === 'face_capture' && c.obrigatorio);

  if (!temPhotoObrigatorio && !temFaceCaptObrigatorio) {
    return null; // nada a validar
  }

  // Busca estado atual da solicitação
  const solResult = await query<{
    foto_perfil_url: string | null;
  }>(
    `SELECT foto_perfil_url FROM people.solicitacoes_admissao WHERE id = $1`,
    [solicitacaoId]
  );

  if (solResult.rows.length === 0) {
    return null; // solicitação não encontrada — deixa a checagem principal tratar
  }

  const sol = solResult.rows[0];

  // Valida campo photo obrigatório
  if (temPhotoObrigatorio && !sol.foto_perfil_url) {
    return 'Foto de perfil obrigatória não foi enviada. Envie a foto antes de reenviar o formulário.';
  }

  // Valida campo face_capture obrigatório
  if (temFaceCaptObrigatorio) {
    const bioResult = await query<{ qualidade: number | null }>(
      `SELECT qualidade FROM people.biometria_facial_pendente WHERE solicitacao_id = $1`,
      [solicitacaoId]
    );

    if (bioResult.rows.length === 0) {
      return 'Biometria facial obrigatória não foi capturada. Realize a captura antes de reenviar o formulário.';
    }

    const qualidade = bioResult.rows[0].qualidade ?? 0;
    if (qualidade < QUALIDADE_MINIMA_BIOMETRIA) {
      return `Qualidade da biometria (${qualidade.toFixed(2)}) abaixo do mínimo exigido (${QUALIDADE_MINIMA_BIOMETRIA}). Refaça a captura facial.`;
    }
  }

  return null;
}
