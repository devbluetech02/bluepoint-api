import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getClient, query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { isApiKeyAuth, withAuth } from '@/lib/middleware';
import { agendarReuniaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { criarNotificacaoComPush } from '@/lib/notificacoes';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    if (isApiKeyAuth(user)) {
      return errorResponse('Este endpoint requer autenticação via usuário (JWT)', 403);
    }

    const client = await getClient();
    let inTransaction = false;
    try {
      const body = await req.json();
      const validation = validateBody(agendarReuniaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const dataInicio = new Date(data.dataInicio);
      const dataFim = new Date(data.dataFim);

      if (dataFim <= dataInicio) {
        return errorResponse('Data de fim deve ser posterior à data de início');
      }

      if (dataInicio < new Date()) {
        return errorResponse('Data de início não pode ser no passado');
      }

      // Verificar se participantes existem
      const participantesResult = await query(
        `SELECT id FROM people.colaboradores
         WHERE id = ANY($1) AND status = 'ativo'`,
        [data.participantesIds]
      );

      if (participantesResult.rows.length !== data.participantesIds.length) {
        return errorResponse('Um ou mais participantes não encontrados ou inativos');
      }

      const sala = crypto.randomUUID();

      await client.query('BEGIN');
      inTransaction = true;

      const result = await client.query(
        `INSERT INTO people.reunioes (
          sala, titulo, descricao, data_inicio, data_fim, anfitriao_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, sala, status, criado_em`,
        [sala, data.titulo, data.descricao || null, dataInicio, dataFim, user.userId]
      );

      const reuniao = result.rows[0];

      // Inserir participantes (anfitrião + convidados)
      const todosParticipantes = [...new Set([user.userId, ...data.participantesIds])];

      for (const colaboradorId of todosParticipantes) {
        const status = colaboradorId === user.userId ? 'confirmado' : 'pendente';
        await client.query(
          `INSERT INTO people.reunioes_participantes (reuniao_id, colaborador_id, status)
           VALUES ($1, $2, $3)
           ON CONFLICT (reuniao_id, colaborador_id) DO NOTHING`,
          [reuniao.id, colaboradorId, status]
        );
      }

      await client.query('COMMIT');
      inTransaction = false;

      // Notificar convidados (exceto o anfitrião)
      const dataFormatada = dataInicio.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      for (const colaboradorId of data.participantesIds) {
        if (colaboradorId === user.userId) continue;
        criarNotificacaoComPush({
          usuarioId: colaboradorId,
          tipo: 'lembrete',
          titulo: 'Você foi convidado para uma reunião',
          mensagem: `"${data.titulo}" — ${dataFormatada}`,
          link: `/reuniao/${sala}`,
          metadados: { acao: 'reuniao_convidado', reuniaoId: reuniao.id, sala },
          pushSeveridade: 'info',
        }).catch((err) => console.error('[Notificação] Erro ao notificar reunião:', err));
      }

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'reunioes',
        descricao: `Reunião agendada: ${data.titulo}`,
        entidadeId: reuniao.id,
        entidadeTipo: 'reuniao',
        dadosNovos: {
          reuniaoId: reuniao.id,
          sala,
          titulo: data.titulo,
          dataInicio: data.dataInicio,
          dataFim: data.dataFim,
          participantes: todosParticipantes,
        },
      }));

      return createdResponse({
        id: reuniao.id,
        sala: reuniao.sala,
        titulo: data.titulo,
        dataInicio: data.dataInicio,
        dataFim: data.dataFim,
        status: reuniao.status,
        link: `/reuniao/${sala}`,
        criadoEm: reuniao.criado_em,
        mensagem: 'Reunião agendada com sucesso',
      });
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Erro ao executar ROLLBACK:', rollbackError);
        }
      }
      console.error('Erro ao agendar reunião:', error);
      return serverErrorResponse('Erro ao agendar reunião');
    } finally {
      client.release();
    }
  });
}
