import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarFeriasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const feriasId = parseInt(id);

      if (isNaN(feriasId)) {
        return notFoundResponse('Período de férias não encontrado');
      }

      const body = await req.json();

      const validation = validateBody(atualizarFeriasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      if (!data.dataInicio && !data.dataFim && data.observacao === undefined) {
        return errorResponse('Nenhum campo para atualizar', 400);
      }

      const existente = await query(
        `SELECT pf.*, c.nome as colaborador_nome
         FROM bluepoint.bt_periodos_ferias pf
         JOIN bluepoint.bt_colaboradores c ON pf.colaborador_id = c.id
         WHERE pf.id = $1`,
        [feriasId]
      );

      if (existente.rows.length === 0) {
        return notFoundResponse('Período de férias não encontrado');
      }

      const atual = existente.rows[0];
      const novoInicio = data.dataInicio || String(atual.data_inicio).substring(0, 10);
      const novoFim = data.dataFim || String(atual.data_fim).substring(0, 10);

      if (new Date(novoFim) < new Date(novoInicio)) {
        return errorResponse('Data fim deve ser maior ou igual à data início', 400);
      }

      if (data.dataInicio || data.dataFim) {
        const sobreposicao = await query(
          `SELECT id FROM bluepoint.bt_periodos_ferias
           WHERE colaborador_id = $1
             AND id != $2
             AND data_inicio <= $3::date
             AND data_fim >= $4::date`,
          [atual.colaborador_id, feriasId, novoFim, novoInicio]
        );

        if (sobreposicao.rows.length > 0) {
          return errorResponse('Já existe período de férias que se sobrepõe às datas informadas', 409);
        }
      }

      const sets: string[] = [];
      const params_query: unknown[] = [];
      let pi = 1;

      if (data.dataInicio) {
        sets.push(`data_inicio = $${pi}`);
        params_query.push(data.dataInicio);
        pi++;
      }

      if (data.dataFim) {
        sets.push(`data_fim = $${pi}`);
        params_query.push(data.dataFim);
        pi++;
      }

      if (data.observacao !== undefined) {
        sets.push(`observacao = $${pi}`);
        params_query.push(data.observacao || null);
        pi++;
      }

      params_query.push(feriasId);

      const result = await query(
        `UPDATE bluepoint.bt_periodos_ferias
         SET ${sets.join(', ')}
         WHERE id = $${pi}
         RETURNING id, colaborador_id, data_inicio, data_fim, observacao`,
        params_query
      );

      const atualizado = result.rows[0];
      const d1 = new Date(atualizado.data_inicio);
      const d2 = new Date(atualizado.data_fim);
      const dias = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'ferias',
        descricao: `Férias atualizadas de ${atual.colaborador_nome}: ${atualizado.data_inicio} a ${atualizado.data_fim}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { dataInicio: atual.data_inicio, dataFim: atual.data_fim, observacao: atual.observacao },
        dadosNovos: { dataInicio: atualizado.data_inicio, dataFim: atualizado.data_fim, observacao: atualizado.observacao },
      });

      return successResponse({
        id: atualizado.id,
        colaborador: { id: atualizado.colaborador_id, nome: atual.colaborador_nome },
        dataInicio: atualizado.data_inicio,
        dataFim: atualizado.data_fim,
        dias,
        observacao: atualizado.observacao,
        mensagem: 'Férias atualizadas com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar férias:', error);
      return serverErrorResponse('Erro ao atualizar férias');
    }
  });
}
