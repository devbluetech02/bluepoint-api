import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { criarSolicitacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateSolicitacaoCache } from '@/lib/cache';
import { calcularCustoHoraExtra, salvarCustoHoraExtra } from '@/lib/custoHorasExtrasService';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { criarNotificacaoComPush } from '@/lib/notificacoes';
import { obterFotoColaborador } from '@/lib/storage';

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
          `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo' AND tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')`,
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
            `SELECT id FROM solicitacoes
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
          `UPDATE solicitacoes
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
            `INSERT INTO solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
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
        `INSERT INTO solicitacoes (
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
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Solicitação criada')`,
        [solicitacao.id, user.userId]
      );

      // Vincular anexos se informados
      if (data.anexosIds && data.anexosIds.length > 0) {
        for (const anexoId of data.anexosIds) {
          await client.query(
            `UPDATE anexos SET solicitacao_id = $1 WHERE id = $2 AND colaborador_id = $3`,
            [solicitacao.id, anexoId, user.userId]
          );
        }
      }

      await client.query('COMMIT');

      await embedTableRowAfterInsert('solicitacoes', solicitacao.id);

      // Notificar gestores sobre a nova solicitação (fire-and-forget)
      notificarGestoresSobreSolicitacao({
        solicitacaoId: solicitacao.id,
        tipo: data.tipo,
        colaboradorId: user.userId,
        gestorIdEspecifico: data.tipo === 'hora_extra' && data.gestorId ? data.gestorId : undefined,
      }).catch((err) => console.error('[Notificação] Erro ao notificar gestores:', err));

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
        acao: 'criar',
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

const NOMES_TIPO: Record<string, string> = {
  ajuste_ponto: 'ajuste de ponto',
  ferias: 'férias',
  atestado: 'atestado médico',
  ausencia: 'ausência',
  hora_extra: 'hora extra',
  atraso: 'registro de atraso',
  outros: 'solicitação',
};

async function notificarGestoresSobreSolicitacao(opts: {
  solicitacaoId: number;
  tipo: string;
  colaboradorId: number;
  gestorIdEspecifico?: number;
}): Promise<void> {
  const { solicitacaoId, tipo, colaboradorId, gestorIdEspecifico } = opts;

  // Buscar dados do colaborador
  const colabResult = await query(
    `SELECT nome, empresa_id, departamento_id FROM people.colaboradores WHERE id = $1`,
    [colaboradorId]
  );
  if (colabResult.rows.length === 0) return;
  const { nome: colabNome, empresa_id, departamento_id } = colabResult.rows[0];

  // Buscar foto do colaborador (pode ser null)
  const fotoUrl = await obterFotoColaborador(colaboradorId).catch(() => null);

  // Determinar quais gestores notificar
  let gestorIds: number[];

  if (gestorIdEspecifico) {
    // Hora extra: notifica apenas o gestor escolhido pelo colaborador
    gestorIds = [gestorIdEspecifico];
  } else {
    // Demais tipos: liderancas do departamento + todos admins/gestores
    const ids = new Set<number>();

    if (empresa_id && departamento_id) {
      const liderResult = await query(
        `SELECT supervisor_ids, coordenador_ids, gerente_ids
         FROM people.liderancas_departamento
         WHERE empresa_id = $1 AND departamento_id = $2`,
        [empresa_id, departamento_id]
      );
      if (liderResult.rows.length > 0) {
        const l = liderResult.rows[0];
        for (const id of [...(l.supervisor_ids ?? []), ...(l.coordenador_ids ?? []), ...(l.gerente_ids ?? [])]) {
          ids.add(id);
        }
      }
    }

    const adminsResult = await query(
      `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
    );
    for (const row of adminsResult.rows) ids.add(row.id);

    gestorIds = [...ids];
  }

  // Nunca notificar o próprio solicitante
  gestorIds = gestorIds.filter((id) => id !== colaboradorId);
  if (gestorIds.length === 0) return;

  const nomeTipo = NOMES_TIPO[tipo] ?? 'solicitação';
  const titulo = `Nova solicitação de ${nomeTipo}`;
  const mensagem = `${colabNome} enviou uma solicitação de ${nomeTipo} aguardando aprovação.`;

  for (const gestorId of gestorIds) {
    criarNotificacaoComPush({
      usuarioId: gestorId,
      tipo: 'solicitacao',
      titulo,
      mensagem,
      link: `/solicitacoes/${solicitacaoId}`,
      metadados: {
        acao: 'nova_solicitacao',
        solicitacaoId,
        tipo,
        colaboradorId,
        colaboradorNome: colabNome,
      },
      pushSeveridade: 'atencao',
      fotoUrl: fotoUrl ?? undefined,
    }).catch((err) => console.error('[Notificação] Erro ao notificar gestor:', err));
  }
}
