import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria } from '@/lib/audit';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

interface Params {
  params: Promise<{ id: string }>;
}

const cancelarSchema = z.object({
  motivo: z.string().trim().max(1000).optional().nullable(),
});

/**
 * POST /api/v1/admissao/solicitacoes/:id/cancelar
 *
 * Cancela uma solicitação de pré-admissão conforme FLUXO_RECRUTAMENTO.md §5.
 *
 * Regras:
 *  - Bloqueia quando status = 'admitido' (ali o caminho saudável é
 *    desligamento, não cancelamento).
 *  - Idempotente: se já estava cancelada, devolve o estado atual sem refazer.
 *  - Se existe documento_assinatura_id, tenta cancelar na SignProof
 *    (POST /integration/documents/:id/cancel) — independentemente do status
 *    atual do contrato, inclusive quando já estiver assinado. Falha na
 *    SignProof NÃO reverte o cancelamento local (best-effort, com warning).
 *  - NÃO envia push/WhatsApp ao candidato (decisão da §5: a empresa exige
 *    motivo antes de autorizar cancelamento; risco de "aparecer mesmo assim"
 *    é desprezível).
 *
 * Restrito a gestão (DP). Body: { motivo?: string }.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;

      const body = await req.json().catch(() => ({}));
      const validation = validateBody(cancelarSchema, body ?? {});
      if (!validation.success) {
        const firstError = Object.values(validation.errors)[0]?.[0];
        return errorResponse(firstError ?? 'Dados inválidos', 400);
      }
      const motivo = validation.data.motivo?.trim() || null;

      const existing = await query<{
        id: string;
        status: string;
        usuario_provisorio_id: number | null;
        documento_assinatura_id: string | null;
      }>(
        `SELECT id, status, usuario_provisorio_id, documento_assinatura_id
           FROM people.solicitacoes_admissao
          WHERE id = $1`,
        [id],
      );

      if (existing.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const sol = existing.rows[0];

      if (sol.status === 'admitido') {
        return errorResponse(
          'Não é possível cancelar uma solicitação já admitida — nesse ponto use o fluxo de desligamento',
          409,
        );
      }

      // Race com o cron do SignProof: se o candidato assinou e o cron
      // transicionou para contrato_assinado enquanto DP clicava em cancelar,
      // a solicitação já está pronta pra virar colaborador. Bloquear aqui
      // evita corromper o estado; DP pode reprovar no passo seguinte (rejeitado).
      if (sol.status === 'contrato_assinado') {
        return errorResponse(
          'O candidato já assinou o contrato. Use "rejeitar" se quiser interromper a admissão.',
          409,
        );
      }

      if (sol.status === 'cancelado') {
        return successResponse({
          id: sol.id,
          status: 'cancelado',
          jaEstavaCancelado: true,
        });
      }

      // Tenta cancelar TODOS os contratos vinculados na SignProof (cascade).
      // Coleta IDs de duas fontes:
      //   - solicitacoes_admissao_documentos (status='enviado') — caminho novo
      //     com 1:N para multi-doc.
      //   - solicitacoes_admissao.documento_assinatura_id — fallback legado
      //     (pode coincidir com um dos IDs acima; deduplicado via Set).
      // Best-effort: falha em qualquer cancel não reverte o cancelamento local.
      const docIdsParaCancelar = new Set<string>();
      const docsResult = await query<{ signproof_doc_id: string }>(
        `SELECT signproof_doc_id
           FROM people.solicitacoes_admissao_documentos
          WHERE solicitacao_id = $1
            AND status = 'enviado'`,
        [id],
      );
      for (const row of docsResult.rows) docIdsParaCancelar.add(row.signproof_doc_id);
      if (sol.documento_assinatura_id) docIdsParaCancelar.add(sol.documento_assinatura_id);

      const signProofWarnings: string[] = [];
      for (const docId of docIdsParaCancelar) {
        const resultado = await cancelarDocumentoSignProof(docId);
        if (!resultado.ok) {
          signProofWarnings.push(`${docId}:${resultado.reason}`);
          console.warn('[admissao.cancelar] SignProof cancel falhou', {
            solicitacaoId: id,
            documentoId:   docId,
            reason:        resultado.reason,
          });
        }
      }
      // Marcador legado mantido pra não quebrar campos do response/auditoria.
      const signProofWarning: string | null = signProofWarnings.length > 0
        ? signProofWarnings[0]
        : null;

      // userId negativo = API Key (ver middleware.apiKeyToJwtPayload) —
      // não gravamos isso em cancelado_por porque aponta pra tabela de usuários.
      const canceladoPor = user.userId > 0 ? user.userId : null;

      // WHERE condicional pra fechar a race com o cron do SignProof:
      // se entre o SELECT acima e o UPDATE o status virou admitido/contrato_assinado,
      // a UPDATE não mexe e respondemos 409.
      const updateResult = await query<{ id: string; status: string }>(
        `UPDATE people.solicitacoes_admissao
            SET status              = 'cancelado',
                cancelado_por       = $1,
                cancelado_em        = NOW(),
                cancelado_em_etapa  = $2,
                motivo_cancelamento = $3,
                atualizado_em       = NOW()
          WHERE id = $4
            AND status NOT IN ('admitido', 'contrato_assinado', 'cancelado')
        RETURNING id, status`,
        [canceladoPor, sol.status, motivo, id],
      );
      if (updateResult.rows.length === 0) {
        return errorResponse(
          'Solicitação mudou de estado — atualize a tela e verifique o status atual',
          409,
        );
      }

      // Cascade: marca todos os documentos pendentes como 'cancelado' em
      // solicitacoes_admissao_documentos, espelhando o estado do envelope no
      // SignProof. Idempotente — só toca docs ainda em 'enviado'.
      await query(
        `UPDATE people.solicitacoes_admissao_documentos
            SET status = 'cancelado',
                cancelado_em = NOW(),
                atualizado_em = NOW()
          WHERE solicitacao_id = $1
            AND status = 'enviado'`,
        [id],
      );

      // Costura com Recrutamento: quando essa solicitação foi aberta a partir
      // de um processo_seletivo (caminho A ou B), também cancelamos o registro
      // de lá pra liberar o CPF do unique parcial uq_processo_seletivo_cpf_vivo.
      // Idempotente: se não há vínculo, o UPDATE simplesmente não afeta linhas.
      await query(
        `UPDATE people.processo_seletivo
            SET status              = 'cancelado',
                cancelado_por       = $1,
                cancelado_em        = NOW(),
                cancelado_em_etapa  = $2,
                motivo_cancelamento = COALESCE($3, motivo_cancelamento),
                atualizado_em       = NOW()
          WHERE solicitacao_admissao_id = $4 AND status <> 'cancelado'`,
        [canceladoPor, `admissao.${sol.status}`, motivo, id],
      );

      registrarAuditoria({
        usuarioId:    canceladoPor,
        usuarioNome:  user.nome,
        usuarioEmail: user.email,
        acao:         'editar',
        modulo:       'admissao',
        descricao:    `Cancelamento de pré-admissão na etapa '${sol.status}'${motivo ? `: ${motivo}` : ''}`,
        entidadeTipo: 'solicitacao_admissao',
        metadados: {
          solicitacaoId:          id,
          etapaAnterior:          sol.status,
          motivo,
          documentoAssinaturaId:  sol.documento_assinatura_id,
          documentosCancelados:   Array.from(docIdsParaCancelar),
          signProofCancelado:     docIdsParaCancelar.size > 0 ? signProofWarnings.length === 0 : null,
          signProofWarnings,
          signProofWarning,
        },
      }).catch(console.error);

      return successResponse({
        id:               sol.id,
        status:           'cancelado',
        canceladoEmEtapa: sol.status,
        motivo,
        ...(signProofWarnings.length > 0
          ? { warnings: signProofWarnings.map(w => `signproof:${w}`) }
          : {}),
      });
    } catch (error) {
      console.error('Erro ao cancelar pré-admissão:', error);
      return serverErrorResponse('Erro ao cancelar pré-admissão');
    }
  });
}

/**
 * Chama POST /integration/documents/:id/cancel na SignProof.
 * Retorna { ok, reason } — nunca lança; o chamador decide o que fazer com a falha.
 *
 * Tratamentos específicos:
 *  - 409 (documento completed/cancelled na SignProof) → motivo esperado, vira warning.
 *  - 404 (documento não existe lá) → idem.
 */
async function cancelarDocumentoSignProof(
  documentoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey  = process.env.SIGNPROOF_API_KEY;

  if (!baseUrl || !apiKey) {
    return { ok: false, reason: 'credenciais_ausentes' };
  }

  try {
    const resp = await fetch(
      `${baseUrl}/api/v1/integration/documents/${documentoId}/cancel`,
      {
        method:  'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      },
    );
    if (resp.ok) return { ok: true };
    if (resp.status === 409) return { ok: false, reason: 'documento_em_estado_final' };
    if (resp.status === 404) return { ok: false, reason: 'documento_nao_encontrado' };
    return { ok: false, reason: `http_${resp.status}` };
  } catch {
    return { ok: false, reason: 'rede' };
  }
}
