import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { solicitarAjustePontoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(solicitarAjustePontoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se todas as marcações existem e pertencem ao usuário
      const marcacaoIds = data.ajustes.map(a => a.marcacaoId);
      const marcacoesResult = await query(
        `SELECT id, data_hora FROM people.marcacoes WHERE id = ANY($1) AND colaborador_id = $2`,
        [marcacaoIds, user.userId]
      );

      if (marcacoesResult.rows.length !== marcacaoIds.length) {
        const encontrados = marcacoesResult.rows.map(r => r.id);
        const naoEncontrados = marcacaoIds.filter(id => !encontrados.includes(id));
        return errorResponse(`Marcação(ões) não encontrada(s): ${naoEncontrados.join(', ')}`, 404);
      }

      const marcacoesMap = new Map(marcacoesResult.rows.map(r => [r.id, r]));

      // Montar dados de cada ajuste com horário original
      const ajustesComOriginal = data.ajustes.map(a => ({
        marcacaoId: a.marcacaoId,
        dataHoraCorreta: a.dataHoraCorreta,
        dataHoraOriginal: marcacoesMap.get(a.marcacaoId)?.data_hora,
      }));

      const primeiraData = marcacoesMap.get(marcacaoIds[0])?.data_hora;

      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'ajuste_ponto', $2, $3, $4, $5)
        RETURNING id`,
        [
          user.userId,
          primeiraData,
          data.motivo,
          data.justificativa,
          JSON.stringify({ ajustes: ajustesComOriginal }),
        ]
      );

      const solicitacaoId = result.rows[0].id;

      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, $3)`,
        [solicitacaoId, user.userId, `Solicitação de ajuste de ponto criada (${data.ajustes.length} marcação(ões))`]
      );

      await client.query('COMMIT');

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'solicitacoes',
        descricao: `Solicitação de ajuste de ponto criada (${data.ajustes.length} marcação(ões))`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return createdResponse({
        solicitacaoId,
        status: 'pendente',
        totalAjustes: data.ajustes.length,
        mensagem: `Solicitação de ajuste de ponto criada com sucesso (${data.ajustes.length} marcação(ões))`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao solicitar ajuste de ponto:', error);
      return serverErrorResponse('Erro ao criar solicitação');
    } finally {
      client.release();
    }
  });
}
