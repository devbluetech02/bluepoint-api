import { NextRequest } from 'next/server';
import { getClient, query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { solicitarFeriasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(solicitarFeriasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      await client.query('BEGIN');

      // Criar solicitação
      const result = await client.query(
        `INSERT INTO solicitacoes (
          colaborador_id, tipo, data_evento, data_evento_fim, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'ferias', $2, $3, $4, $5, $6)
        RETURNING id`,
        [
          user.userId,
          data.dataInicio,
          data.dataFim,
          `Solicitação de ${data.dias} dias de férias`,
          data.observacao || 'Solicitação de férias',
          JSON.stringify({
            dias: data.dias,
            dataInicio: data.dataInicio,
            dataFim: data.dataFim,
          }),
        ]
      );

      const solicitacaoId = result.rows[0].id;

      // Registrar histórico
      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Solicitação de férias criada')`,
        [solicitacaoId, user.userId]
      );

      await client.query('COMMIT');

      // Buscar saldo disponível (simplificado - em produção seria mais complexo)
      const colaboradorResult = await query(
        `SELECT data_admissao FROM people.colaboradores WHERE id = $1`,
        [user.userId]
      );
      
      // Cálculo simplificado de saldo de férias
      const dataAdmissao = new Date(colaboradorResult.rows[0].data_admissao);
      const hoje = new Date();
      const mesesTrabalhados = Math.floor((hoje.getTime() - dataAdmissao.getTime()) / (1000 * 60 * 60 * 24 * 30));
      const saldoDisponivel = Math.min(30, Math.floor(mesesTrabalhados * 2.5)); // 2.5 dias por mês

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'solicitacoes',
        descricao: `Solicitação de ${data.dias} dias de férias`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return createdResponse({
        solicitacaoId,
        status: 'pendente',
        diasSolicitados: data.dias,
        saldoDisponivel,
        mensagem: 'Solicitação de férias criada com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao solicitar férias:', error);
      return serverErrorResponse('Erro ao criar solicitação');
    } finally {
      client.release();
    }
  });
}
