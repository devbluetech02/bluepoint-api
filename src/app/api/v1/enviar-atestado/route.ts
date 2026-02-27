import { NextRequest } from 'next/server';
import { getClient, query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { enviarAtestadoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(enviarAtestadoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se anexo existe e pertence ao usuário
      const anexoResult = await query(
        `SELECT id FROM bt_anexos WHERE id = $1 AND colaborador_id = $2`,
        [data.anexoId, user.userId]
      );

      if (anexoResult.rows.length === 0) {
        return errorResponse('Anexo não encontrado', 404);
      }

      // Calcular dias de afastamento
      const dataInicio = new Date(data.dataInicio);
      const dataFim = new Date(data.dataFim);
      const diasAfastamento = Math.ceil((dataFim.getTime() - dataInicio.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      await client.query('BEGIN');

      // Criar solicitação
      const result = await client.query(
        `INSERT INTO bt_solicitacoes (
          colaborador_id, tipo, data_evento, data_evento_fim, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'atestado', $2, $3, $4, $5, $6)
        RETURNING id`,
        [
          user.userId,
          data.dataInicio,
          data.dataFim,
          `Atestado médico - ${diasAfastamento} dia(s)`,
          data.observacao || 'Envio de atestado médico',
          JSON.stringify({
            cid: data.cid,
            diasAfastamento,
            dataInicio: data.dataInicio,
            dataFim: data.dataFim,
          }),
        ]
      );

      const solicitacaoId = result.rows[0].id;

      // Vincular anexo
      await client.query(
        `UPDATE bt_anexos SET solicitacao_id = $1 WHERE id = $2`,
        [solicitacaoId, data.anexoId]
      );

      // Registrar histórico
      await client.query(
        `INSERT INTO bt_solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Atestado médico enviado')`,
        [solicitacaoId, user.userId]
      );

      await client.query('COMMIT');

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'solicitacoes',
        descricao: `Atestado médico enviado - ${diasAfastamento} dia(s)`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return createdResponse({
        solicitacaoId,
        status: 'pendente',
        diasAfastamento,
        mensagem: 'Atestado enviado com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao enviar atestado:', error);
      return serverErrorResponse('Erro ao enviar atestado');
    } finally {
      client.release();
    }
  });
}
