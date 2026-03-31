import { NextRequest } from 'next/server';
import { getClient, query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { justificarAtrasoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { enviarJustificativaAtrasoAoPortal } from '@/lib/ocorrencias-externas';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();

    try {
      const body = await req.json();

      const validation = validateBody(justificarAtrasoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se a marcação existe, pertence ao colaborador e é de entrada/retorno
      const marcacaoResult = await query(
        `SELECT m.id, m.data_hora, m.tipo, m.colaborador_id, m.ocorrencia_portal_id,
                c.nome as colaborador_nome
         FROM people.marcacoes m
         JOIN people.colaboradores c ON m.colaborador_id = c.id
         WHERE m.id = $1 AND m.colaborador_id = $2`,
        [data.marcacaoId, user.userId]
      );

      if (marcacaoResult.rows.length === 0) {
        return errorResponse('Marcação não encontrada ou não pertence a este colaborador', 404);
      }

      const marcacao = marcacaoResult.rows[0];

      if (marcacao.tipo !== 'entrada' && marcacao.tipo !== 'retorno') {
        return errorResponse('Apenas marcações de entrada ou retorno podem ser justificadas como atraso', 400);
      }

      // Verificar se já existe justificativa de atraso para esta marcação
      const existeResult = await query(
        `SELECT id FROM solicitacoes
         WHERE colaborador_id = $1
           AND tipo = 'outros'
           AND dados_adicionais->>'marcacaoId' = $2
           AND dados_adicionais->>'tipo_justificativa' = 'atraso'`,
        [user.userId, String(data.marcacaoId)]
      );

      if (existeResult.rows.length > 0) {
        return errorResponse('Já existe uma justificativa de atraso para esta marcação', 409);
      }

      // Verificar anexo se informado
      if (data.anexoId) {
        const anexoResult = await query(
          `SELECT id FROM anexos WHERE id = $1 AND colaborador_id = $2`,
          [data.anexoId, user.userId]
        );

        if (anexoResult.rows.length === 0) {
          return errorResponse('Anexo não encontrado', 404);
        }
      }

      await client.query('BEGIN');

      const dataEvento = marcacao.data_hora?.split?.(' ')?.[0]
        || marcacao.data_hora?.split?.('T')?.[0]
        || new Date().toISOString().split('T')[0];

      // Criar solicitação tipo 'outros' com dados_adicionais identificando como justificativa de atraso
      const result = await client.query(
        `INSERT INTO solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'outros', $2, $3, $4, $5)
        RETURNING id`,
        [
          user.userId,
          dataEvento,
          `Justificativa de atraso — ${data.motivo}`,
          data.justificativa,
          JSON.stringify({
            tipo_justificativa: 'atraso',
            marcacaoId: data.marcacaoId,
            motivo: data.motivo,
          }),
        ]
      );

      const solicitacaoId = result.rows[0].id;

      // Vincular anexo se informado
      if (data.anexoId) {
        await client.query(
          `UPDATE anexos SET solicitacao_id = $1 WHERE id = $2`,
          [solicitacaoId, data.anexoId]
        );
      }

      // Registrar histórico
      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Justificativa de atraso criada pelo colaborador')`,
        [solicitacaoId, user.userId]
      );

      // Atualizar justificativa na própria marcação
      await client.query(
        `UPDATE people.marcacoes
         SET justificativa = $1, atualizado_em = NOW()
         WHERE id = $2`,
        [data.justificativa, data.marcacaoId]
      );

      await client.query('COMMIT');

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'solicitacoes',
        descricao: `Justificativa de atraso: ${data.motivo} (marcação #${data.marcacaoId})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { solicitacaoId, marcacaoId: data.marcacaoId, motivo: data.motivo },
      });

      // Enviar justificativa à ocorrência existente no Portal do Colaborador
      if (marcacao.ocorrencia_portal_id) {
        enviarJustificativaAtrasoAoPortal({
          ocorrenciaPortalId: marcacao.ocorrencia_portal_id,
          motivo: data.motivo,
          justificativa: data.justificativa,
        }).catch((err) => {
          console.error('[Justificativa] Erro ao enviar justificativa ao Portal (async):', err);
        });
      } else {
        console.warn(
          `[Justificativa] Marcação #${data.marcacaoId} não possui ocorrencia_portal_id. ` +
          `Justificativa salva localmente mas não enviada ao Portal.`
        );
      }

      return createdResponse({
        solicitacaoId,
        marcacaoId: data.marcacaoId,
        status: 'pendente',
        enviadaAoPortal: !!marcacao.ocorrencia_portal_id,
        mensagem: marcacao.ocorrencia_portal_id
          ? 'Justificativa de atraso enviada com sucesso'
          : 'Justificativa salva. A ocorrência no Portal ainda não foi vinculada — tente novamente em instantes.',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao justificar atraso:', error);
      return serverErrorResponse('Erro ao criar justificativa de atraso');
    } finally {
      client.release();
    }
  });
}
