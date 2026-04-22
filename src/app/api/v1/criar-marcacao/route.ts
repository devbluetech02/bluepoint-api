import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarMarcacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateMarcacaoCache } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { criarNotificacaoComPush } from '@/lib/notificacoes';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarMarcacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo'`,
        [data.colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      // Inserir marcação manual
      const result = await query(
        `INSERT INTO people.marcacoes (
          colaborador_id, empresa_id, data_hora, tipo, observacao, justificativa, criado_por
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, data_hora, tipo`,
        [
          data.colaboradorId,
          data.empresaId || null,
          data.dataHora,
          data.tipo,
          data.observacao || null,
          data.justificativa,
          user.userId,
        ]
      );

      const marcacao = result.rows[0];

      await invalidateMarcacaoCache(data.colaboradorId);
      await embedTableRowAfterInsert('marcacoes', marcacao.id);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'marcacoes',
        descricao: `Marcação manual criada para ${colaboradorResult.rows[0].nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          marcacaoId: marcacao.id,
          colaboradorId: data.colaboradorId,
          tipo: data.tipo,
          dataHora: data.dataHora,
        },
      });

      const tipoLabel: Record<string, string> = {
        entrada: 'entrada', saida: 'saída', inicio_intervalo: 'início de intervalo', fim_intervalo: 'fim de intervalo',
      };
      const horaFormatada = new Date(marcacao.data_hora).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });
      criarNotificacaoComPush({
        usuarioId: data.colaboradorId,
        tipo: 'marcacao',
        titulo: 'Marcação registrada pelo administrador',
        mensagem: `Uma marcação de ${tipoLabel[marcacao.tipo] ?? marcacao.tipo} foi adicionada às ${horaFormatada} pelo administrador.`,
        link: '/marcacoes',
        metadados: { acao: 'marcacao_manual', marcacaoId: marcacao.id, tipo: marcacao.tipo },
        pushSeveridade: 'info',
      }).catch((err) => console.error('[Notificação] Erro ao notificar marcação manual:', err));

      return createdResponse({
        id: marcacao.id,
        mensagem: 'Marcação criada com sucesso',
        marcacao: {
          id: marcacao.id,
          dataHora: marcacao.data_hora,
          tipo: marcacao.tipo,
        },
      });
    } catch (error) {
      console.error('Erro ao criar marcação:', error);
      return serverErrorResponse('Erro ao criar marcação');
    }
  });
}
