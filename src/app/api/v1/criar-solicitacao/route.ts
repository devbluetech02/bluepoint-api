import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { criarSolicitacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateSolicitacaoCache } from '@/lib/cache';
import { calcularCustoHoraExtra, salvarCustoHoraExtra } from '@/lib/custoHorasExtrasService';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(criarSolicitacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Se for hora extra, validar o gestor informado
      let gestorNome: string | null = null;
      if (data.tipo === 'hora_extra' && data.gestorId) {
        const gestorResult = await query(
          `SELECT id, nome FROM bluepoint.bt_colaboradores WHERE id = $1 AND status = 'ativo' AND tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')`,
          [data.gestorId]
        );

        if (gestorResult.rows.length === 0) {
          return errorResponse('Gestor não encontrado, inativo ou sem permissão de gestor', 404);
        }

        gestorNome = gestorResult.rows[0].nome;
      }

      await client.query('BEGIN');

      // Se for hora_extra, verificar duplicidade (mesmo colaborador, data e horário) dentro da transação
      if (data.tipo === 'hora_extra' && data.dataEvento && data.dadosAdicionais) {
        const da = data.dadosAdicionais as Record<string, unknown>;
        const horaInicio = typeof da.horaInicio === 'string' ? da.horaInicio : null;
        const horaFim = typeof da.horaFim === 'string' ? da.horaFim : null;
        if (horaInicio && horaFim) {
          const dup = await client.query(
            `SELECT id FROM bt_solicitacoes
             WHERE colaborador_id = $1 AND tipo = 'hora_extra'
               AND status IN ('pendente', 'aprovada')
               AND data_evento = $2::date
               AND dados_adicionais->>'horaInicio' = $3
               AND dados_adicionais->>'horaFim' = $4`,
            [user.userId, data.dataEvento, horaInicio, horaFim]
          );
          if (dup.rows.length > 0) {
            await client.query('ROLLBACK');
            return errorResponse('Já existe solicitação de hora extra para este colaborador neste horário', 409);
          }
        }
      }

      // Se for hora_extra, cancelar solicitações automáticas pendentes do mesmo colaborador/data
      if (data.tipo === 'hora_extra' && data.dataEvento) {
        const automaticasCanceladas = await client.query(
          `UPDATE bt_solicitacoes
           SET status = 'cancelada', atualizado_em = NOW()
           WHERE colaborador_id = $1
             AND tipo = 'hora_extra'
             AND data_evento = $2::date
             AND status = 'pendente'
             AND origem = 'automatica'
           RETURNING id`,
          [user.userId, data.dataEvento]
        );

        for (const row of automaticasCanceladas.rows) {
          await client.query(
            `INSERT INTO bt_solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
             VALUES ($1, 'pendente', 'cancelada', $2, 'Cancelada automaticamente: colaborador criou solicitação manual para o mesmo dia')`,
            [row.id, user.userId]
          );
        }
      }

      // Montar dados adicionais incluindo gestor se aplicável
      let dadosAdicionais = data.dadosAdicionais || {};
      if (data.tipo === 'hora_extra' && data.gestorId) {
        dadosAdicionais = {
          ...dadosAdicionais,
          gestorId: data.gestorId,
          gestorNome,
        };
      }

      // Inserir solicitação
      const gestorIdValue = data.tipo === 'hora_extra' && data.gestorId ? data.gestorId : null;

      const result = await client.query(
        `INSERT INTO bt_solicitacoes (
          colaborador_id, tipo, data_evento, data_evento_fim, descricao, justificativa, dados_adicionais, gestor_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, tipo, status`,
        [
          user.userId,
          data.tipo,
          data.dataEvento,
          data.dataEventoFim ?? null,
          data.descricao,
          data.justificativa,
          Object.keys(dadosAdicionais).length > 0 ? JSON.stringify(dadosAdicionais) : null,
          gestorIdValue,
        ]
      );

      const solicitacao = result.rows[0];

      // Registrar histórico
      await client.query(
        `INSERT INTO bt_solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Solicitação criada')`,
        [solicitacao.id, user.userId]
      );

      // Vincular anexos se informados
      if (data.anexosIds && data.anexosIds.length > 0) {
        for (const anexoId of data.anexosIds) {
          await client.query(
            `UPDATE bt_anexos SET solicitacao_id = $1 WHERE id = $2 AND colaborador_id = $3`,
            [solicitacao.id, anexoId, user.userId]
          );
        }
      }

      await client.query('COMMIT');

      // Calcular e salvar custos de HE (fora da transação - não bloqueia criação)
      const da = dadosAdicionais as Record<string, unknown>;
      if (data.tipo === 'hora_extra' && typeof da.horaInicio === 'string' && typeof da.horaFim === 'string') {
        try {
          const custos = await calcularCustoHoraExtra(user.userId, da.horaInicio, da.horaFim);
          if (custos) {
            await salvarCustoHoraExtra(
              solicitacao.id,
              user.userId,
              custos.cargo_id,
              custos.empresa_id,
              custos
            );
          }
        } catch (errCusto) {
          console.error('Erro ao calcular/salvar custos HE (não bloqueante):', errCusto);
        }
      }

      // Invalidar cache de solicitações
      await invalidateSolicitacaoCache(undefined, user.userId);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'solicitacoes',
        descricao: `Solicitação criada: ${data.tipo}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: solicitacao.id, tipo: data.tipo },
      });

      return createdResponse({
        id: solicitacao.id,
        tipo: solicitacao.tipo,
        status: 'pendente',
        mensagem: 'Solicitação criada com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar solicitação:', error);
      return serverErrorResponse('Erro ao criar solicitação');
    } finally {
      client.release();
    }
  });
}
