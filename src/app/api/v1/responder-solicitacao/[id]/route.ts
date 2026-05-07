import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  errorResponse,
  forbiddenResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withGestor, isApiKeyAuth } from '@/lib/middleware';
import { validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateSolicitacaoCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { criarNotificacaoComPush } from '@/lib/notificacoes';
import { gestorPodeAcessarColaborador } from '@/lib/escopo-gestor';
import { isSuperAdmin } from '@/lib/auth';

/**
 * PATCH /api/v1/responder-solicitacao/[id]
 *
 * Gestor responde solicitação do tipo "duvida". Atualiza status pra
 * 'respondida', salva texto da resposta e dispara push pro colaborador.
 *
 * Não troca status pra aprovada/rejeitada — fluxo de dúvida é estritamente
 * informativo: gestor lê pergunta, escreve resposta, colaborador recebe.
 */

const schema = z.object({
  resposta: z.string().trim().min(1, 'Resposta obrigatória').max(4000),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, ctx: Params) {
  return PATCH(request, ctx);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id, 10);
      if (Number.isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const body = await req.json().catch(() => ({}));
      const validation = validateBody(schema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }
      const { resposta } = validation.data;

      const r = await query<{
        id: number;
        tipo: string;
        status: string;
        colaborador_id: number;
        descricao: string | null;
        colaborador_nome: string;
      }>(
        `SELECT s.id, s.tipo, s.status, s.colaborador_id, s.descricao,
                c.nome AS colaborador_nome
           FROM solicitacoes s
           JOIN people.colaboradores c ON s.colaborador_id = c.id
          WHERE s.id = $1`,
        [solicitacaoId],
      );
      if (r.rows.length === 0) return notFoundResponse('Solicitação não encontrada');
      const sol = r.rows[0];

      if (sol.tipo !== 'duvida') {
        return errorResponse(
          `Apenas solicitações do tipo "dúvida" podem ser respondidas (tipo atual: ${sol.tipo})`,
          400,
        );
      }
      if (sol.status !== 'pendente') {
        return errorResponse(
          `Solicitação está em status "${sol.status}" — só pendentes podem ser respondidas`,
          409,
        );
      }

      // Escopo: gestor comum só responde dúvidas dentro do seu escopo.
      if (!isSuperAdmin(user) && !isApiKeyAuth(user)) {
        const podeAcessar = await gestorPodeAcessarColaborador(
          user.userId,
          sol.colaborador_id,
        );
        if (!podeAcessar) {
          return forbiddenResponse(
            'Você não tem permissão para responder essa solicitação (fora do seu escopo)',
          );
        }
      }

      const respondidoPor = isApiKeyAuth(user) ? null : user.userId;
      const usuarioHistorico = isApiKeyAuth(user) ? sol.colaborador_id : user.userId;

      await query(
        `UPDATE solicitacoes
            SET status = 'respondida',
                resposta = $1,
                respondido_por = $2,
                respondido_em = NOW(),
                atualizado_em = NOW()
          WHERE id = $3`,
        [resposta, respondidoPor, solicitacaoId],
      );

      await query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', 'respondida', $2, $3)`,
        [solicitacaoId, usuarioHistorico, resposta.slice(0, 500)],
      );

      // Notificação pro colaborador
      try {
        await criarNotificacaoComPush({
          usuarioId: sol.colaborador_id,
          tipo: 'solicitacao',
          titulo: 'Resposta da sua dúvida',
          mensagem:
            resposta.length > 200 ? resposta.slice(0, 197) + '...' : resposta,
          metadados: {
            tipoSolicitacao: 'duvida',
            statusNovo: 'respondida',
            solicitacaoId,
          },
        });
      } catch (e) {
        console.error('Falha ao enviar push de resposta:', e);
      }

      // Cache
      await invalidateSolicitacaoCache(solicitacaoId).catch(() => {});
      cacheDelPattern(`${CACHE_KEYS.SOLICITACOES}*`).catch(() => {});

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'solicitacoes',
          descricao: `Dúvida #${solicitacaoId} respondida`,
          entidadeTipo: 'solicitacao',
          entidadeId: solicitacaoId,
          dadosNovos: { resposta },
        }),
      );

      return successResponse({
        solicitacaoId,
        status: 'respondida',
        resposta,
        respondidoEm: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[responder-solicitacao] erro:', e);
      return serverErrorResponse('Erro ao responder solicitação');
    }
  });
}
