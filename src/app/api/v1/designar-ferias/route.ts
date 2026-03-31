import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { designarFeriasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();

    try {
      const body = await req.json();

      const validation = validateBody(designarFeriasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { colaboradorId, dataInicio, dataFim, observacao } = validation.data;

      await client.query('BEGIN');

      const colabResult = await client.query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo'`,
        [colaboradorId]
      );

      if (colabResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      const colaborador = colabResult.rows[0];

      const sobreposicao = await client.query(
        `SELECT id FROM people.periodos_ferias
         WHERE colaborador_id = $1
           AND data_inicio <= $2::date
           AND data_fim >= $3::date`,
        [colaboradorId, dataFim, dataInicio]
      );

      if (sobreposicao.rows.length > 0) {
        await client.query('ROLLBACK');
        return errorResponse('Já existe período de férias que se sobrepõe às datas informadas', 409);
      }

      const d1 = new Date(dataInicio);
      const d2 = new Date(dataFim);
      const dias = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      // Criar registro de solicitação já aprovada (origem: designação do gestor)
      const solicitacaoResult = await client.query(
        `INSERT INTO solicitacoes (
          colaborador_id, tipo, status, data_evento, data_evento_fim, descricao, justificativa, dados_adicionais, aprovador_id, data_aprovacao, origem
        ) VALUES ($1, 'ferias', 'aprovada', $2, $3, $4, $5, $6, $7, NOW(), 'manual')
        RETURNING id`,
        [
          colaboradorId,
          dataInicio,
          dataFim,
          'Férias designadas de ' + dias + ' dia(s)',
          observacao || 'Férias designadas pelo gestor',
          JSON.stringify({
            dias,
            dataInicio,
            dataFim,
            origem: 'designacao_gestor',
          }),
          user.userId,
        ]
      );

      const solicitacaoId = solicitacaoResult.rows[0].id;

      // Registrar histórico da solicitação já como aprovada
      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'aprovada', $2, 'Férias designadas manualmente pelo gestor')`,
        [solicitacaoId, user.userId]
      );

      // Criar período de férias vinculado à solicitação
      const result = await client.query(
        `INSERT INTO people.periodos_ferias (colaborador_id, data_inicio, data_fim, observacao, designado_por, solicitacao_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, data_inicio, data_fim`,
        [colaboradorId, dataInicio, dataFim, observacao || null, user.userId, solicitacaoId]
      );

      const periodo = result.rows[0];

      await client.query('COMMIT');

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'ferias',
        descricao: `Férias designadas para ${colaborador.nome}: ${dataInicio} a ${dataFim} (${dias} dias)`,
        colaboradorId,
        colaboradorNome: colaborador.nome,
        entidadeId: periodo.id,
        entidadeTipo: 'ferias',
        dadosNovos: { id: periodo.id, colaboradorId, dataInicio, dataFim, dias, solicitacaoId },
      }));

      return createdResponse({
        id: periodo.id,
        colaborador: { id: colaborador.id, nome: colaborador.nome },
        dataInicio: periodo.data_inicio,
        dataFim: periodo.data_fim,
        dias,
        solicitacaoId,
        mensagem: 'Férias designadas com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao designar férias:', error);
      return serverErrorResponse('Erro ao designar férias');
    } finally {
      client.release();
    }
  });
}
