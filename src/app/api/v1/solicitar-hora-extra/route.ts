import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth, isApiKeyAuth } from '@/lib/middleware';
import { solicitarHoraExtraSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateSolicitacaoCache } from '@/lib/cache';
import { calcularCustoHoraExtra, salvarCustoHoraExtra } from '@/lib/custoHorasExtrasService';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();

    try {
      const body = await req.json();

      const validation = validateBody(solicitarHoraExtraSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se colaborador existe e está ativo
      const colaboradorResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo'`,
        [data.colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      const colaborador = colaboradorResult.rows[0];

      // Verificar se gestor existe e está ativo
      const gestorResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo' AND tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')`,
        [data.gestorId]
      );

      if (gestorResult.rows.length === 0) {
        return errorResponse('Gestor não encontrado, inativo ou sem permissão de gestor', 404);
      }

      const gestor = gestorResult.rows[0];

      // Calcular total de horas a partir de horaInicio e horaFim
      const [hIni, mIni] = data.horaInicio.split(':').map(Number);
      const [hFim, mFim] = data.horaFim.split(':').map(Number);
      const minutosInicio = hIni * 60 + mIni;
      const minutosFim = hFim * 60 + mFim;

      if (minutosFim <= minutosInicio) {
        return errorResponse('Hora fim deve ser maior que hora início', 400);
      }

      const totalMinutos = minutosFim - minutosInicio;
      const totalHoras = parseFloat((totalMinutos / 60).toFixed(2));

      await client.query('BEGIN');

      // Verificar duplicidade dentro da transação (evita race: dois requests criando ao mesmo tempo)
      const duplicidadeResult = await client.query(
        `SELECT id FROM solicitacoes
         WHERE colaborador_id = $1
           AND tipo = 'hora_extra'
           AND status IN ('pendente', 'aprovada')
           AND origem = 'manual'
           AND dados_adicionais->>'data' = $2
           AND dados_adicionais->>'horaInicio' = $3
           AND dados_adicionais->>'horaFim' = $4`,
        [data.colaboradorId, data.data, data.horaInicio, data.horaFim]
      );

      if (duplicidadeResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return errorResponse('Já existe solicitação de hora extra para este colaborador neste horário', 409);
      }

      // Cancelar solicitações automáticas pendentes do mesmo colaborador/data
      const automaticasCanceladas = await client.query(
        `UPDATE solicitacoes
         SET status = 'cancelada', atualizado_em = NOW()
         WHERE colaborador_id = $1
           AND tipo = 'hora_extra'
           AND data_evento = $2::date
           AND status = 'pendente'
           AND origem = 'automatica'
         RETURNING id`,
        [data.colaboradorId, data.data]
      );

      for (const row of automaticasCanceladas.rows) {
        await client.query(
          `INSERT INTO solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
           VALUES ($1, 'pendente', 'cancelada', $2, 'Cancelada automaticamente: colaborador criou solicitação manual para o mesmo dia')`,
          [row.id, isApiKeyAuth(user) ? data.colaboradorId : user.userId]
        );
      }

      // Inserir solicitação
      const descricao = `Hora extra: ${data.horaInicio} às ${data.horaFim} (${totalHoras}h) — ${data.motivo} (Gestor: ${gestor.nome})`;

      const result = await client.query(
        `INSERT INTO solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, origem, dados_adicionais, gestor_id
        ) VALUES ($1, 'hora_extra', $2, $3, $4, 'manual', $5, $6)
        RETURNING id, status, data_solicitacao`,
        [
          data.colaboradorId,
          data.data,
          descricao,
          data.motivo,
          JSON.stringify({
            data: data.data,
            horaInicio: data.horaInicio,
            horaFim: data.horaFim,
            totalHoras,
            motivo: data.motivo,
            observacao: data.observacao || null,
            gestorId: data.gestorId,
            gestorNome: gestor.nome,
            origem: 'manual',
          }),
          data.gestorId,
        ]
      );

      const solicitacao = result.rows[0];

      // Registrar histórico (se API Key, usa colaboradorId como fallback)
      const usuarioHistorico = isApiKeyAuth(user) ? data.colaboradorId : user.userId;

      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Solicitação de hora extra criada')`,
        [solicitacao.id, usuarioHistorico]
      );

      // Vincular anexos se informados
      if (data.anexosIds && data.anexosIds.length > 0) {
        for (const anexoId of data.anexosIds) {
          await client.query(
            `UPDATE anexos SET solicitacao_id = $1 WHERE id = $2 AND colaborador_id = $3`,
            [solicitacao.id, anexoId, data.colaboradorId]
          );
        }
      }

      await client.query('COMMIT');

      // Calcular e salvar custos de HE (fora da transação - não bloqueia criação)
      try {
        const custos = await calcularCustoHoraExtra(data.colaboradorId, data.horaInicio, data.horaFim);
        if (custos) {
          await salvarCustoHoraExtra(
            solicitacao.id,
            data.colaboradorId,
            custos.cargo_id,
            custos.empresa_id,
            custos
          );
        }
      } catch (errCusto) {
        console.error('Erro ao calcular/salvar custos HE (não bloqueante):', errCusto);
      }

      // Invalidar cache
      await invalidateSolicitacaoCache(undefined, data.colaboradorId);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'horas_extras',
        descricao: `Solicitação de hora extra criada para ${colaborador.nome}: ${totalHoras}h em ${data.data} (Gestor: ${gestor.nome})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          solicitacaoId: solicitacao.id,
          colaboradorId: data.colaboradorId,
          gestorId: data.gestorId,
          gestorNome: gestor.nome,
          data: data.data,
          horaInicio: data.horaInicio,
          horaFim: data.horaFim,
          totalHoras,
        },
      });

      return createdResponse({
        id: solicitacao.id,
        colaborador: {
          id: colaborador.id,
          nome: colaborador.nome,
        },
        gestor: {
          id: gestor.id,
          nome: gestor.nome,
        },
        tipo: 'hora_extra',
        status: 'pendente',
        data: data.data,
        horaInicio: data.horaInicio,
        horaFim: data.horaFim,
        totalHoras,
        motivo: data.motivo,
        observacao: data.observacao || null,
        origem: 'manual',
        anexos: data.anexosIds?.length || 0,
        dataSolicitacao: solicitacao.data_solicitacao,
        mensagem: 'Solicitação de hora extra criada com sucesso. Aguardando aprovação.',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao solicitar hora extra:', error);
      return serverErrorResponse('Erro ao criar solicitação de hora extra');
    } finally {
      client.release();
    }
  });
}
