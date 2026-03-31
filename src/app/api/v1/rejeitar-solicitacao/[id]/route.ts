import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor, isApiKeyAuth } from '@/lib/middleware';
import { rejeitarSolicitacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateSolicitacaoCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { criarNotificacao } from '@/lib/notificacoes';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(rejeitarSolicitacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { motivo } = validation.data;

      // Verificar se solicitação existe e está pendente
      const solicitacaoResult = await query(
        `SELECT s.*, c.nome as colaborador_nome 
         FROM solicitacoes s
         JOIN people.colaboradores c ON s.colaborador_id = c.id
         WHERE s.id = $1`,
        [solicitacaoId]
      );

      if (solicitacaoResult.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const solicitacao = solicitacaoResult.rows[0];

      if (solicitacao.status !== 'pendente') {
        return errorResponse('Apenas solicitações pendentes podem ser rejeitadas', 400);
      }

      // Se API Key, aprovador_id fica null
      const aprovadorId = isApiKeyAuth(user) ? null : user.userId;
      const usuarioHistorico = isApiKeyAuth(user) ? solicitacao.colaborador_id : user.userId;

      // Atualizar solicitação
      await query(
        `UPDATE solicitacoes SET
          status = 'rejeitada',
          aprovador_id = $1,
          data_aprovacao = NOW(),
          motivo_rejeicao = $2,
          atualizado_em = NOW()
        WHERE id = $3`,
        [aprovadorId, motivo, solicitacaoId]
      );

      // Registrar histórico
      await query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', 'rejeitada', $2, $3)`,
        [solicitacaoId, usuarioHistorico, motivo]
      );

      // Contestação rejeitada: relatório volta para assinado
      if (solicitacao.tipo === 'contestacao' && solicitacao.dados_adicionais) {
        const dados = solicitacao.dados_adicionais;
        if (dados.relatorioId) {
          const novoStatus = dados.statusAnterior === 'assinado' ? 'assinado' : 'pendente';
          await query(
            `UPDATE people.relatorios_mensais
             SET status = $1, atualizado_em = NOW()
             WHERE id = $2`,
            [novoStatus, dados.relatorioId]
          );
        }

        criarNotificacao({
          usuarioId: solicitacao.colaborador_id,
          tipo: 'solicitacao',
          titulo: 'Contestação de relatório recusada',
          mensagem: `Sua contestação do relatório ${dados.mes}/${dados.ano} foi recusada. Motivo: "${motivo}".`,
          link: `/relatorios`,
          metadados: { acao: 'contestacao_recusada', solicitacaoId, motivo },
        }).catch((err) => console.error('[Notificação] Erro ao notificar rejeição de contestação:', err));
      }

      // Notificar colaborador sobre rejeição de atraso
      if (solicitacao.tipo === 'atraso') {
        criarNotificacao({
          usuarioId: solicitacao.colaborador_id,
          tipo: 'solicitacao',
          titulo: 'Solicitação de atraso recusada',
          mensagem:
            `Seu gestor recusou a solicitação de registro de ponto com atraso. ` +
            `Motivo: "${motivo}". O ponto não foi registrado.`,
          link: `/solicitacoes/${solicitacaoId}`,
          metadados: {
            acao: 'atraso_recusado',
            solicitacaoId,
            motivo,
          },
        }).catch((err) => console.error('[Notificação] Erro ao notificar rejeição:', err));
      }

      // Invalidar cache de solicitações e horas extras
      await invalidateSolicitacaoCache(solicitacaoId, solicitacao.colaborador_id);
      await cacheDelPattern(`${CACHE_KEYS.HORAS_EXTRAS}*`);

      // Registrar auditoria
      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'rejeitar',
        modulo: 'solicitacoes',
        descricao: `Solicitação rejeitada: ${solicitacao.tipo} de ${solicitacao.colaborador_nome}`,
        colaboradorId: solicitacao.colaborador_id,
        colaboradorNome: solicitacao.colaborador_nome,
        entidadeId: solicitacaoId,
        entidadeTipo: 'solicitacao',
        dadosNovos: { solicitacaoId, status: 'rejeitada', motivo },
      }));

      return successResponse({
        id: solicitacaoId,
        status: 'rejeitada',
        mensagem: 'Solicitação rejeitada',
      });
    } catch (error) {
      console.error('Erro ao rejeitar solicitação:', error);
      return serverErrorResponse('Erro ao rejeitar solicitação');
    }
  });
}
