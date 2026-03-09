import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

const contestarRelatorioSchema = z.object({
  motivo: z.string().min(5, 'Motivo deve ter no mínimo 5 caracteres').max(1000),
  diasContestados: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD')).optional(),
  justificativa: z.string().max(2000).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (req: NextRequest, user: JWTPayload) => {
    const client = await getClient();

    try {
      const { id } = await params;
      const relatorioId = parseInt(id);
      if (isNaN(relatorioId)) {
        return errorResponse('ID do relatório inválido', 400);
      }

      const body = await req.json();
      const validation = validateBody(contestarRelatorioSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const relatorioResult = await query(
        `SELECT id, colaborador_id, mes, ano, status
         FROM bluepoint.bt_relatorios_mensais
         WHERE id = $1`,
        [relatorioId]
      );

      if (relatorioResult.rows.length === 0) {
        return errorResponse('Relatório não encontrado', 404);
      }

      const relatorio = relatorioResult.rows[0];

      if (relatorio.colaborador_id !== user.userId) {
        return errorResponse('O relatório não pertence a este colaborador', 403);
      }

      const statusPermitidos = ['pendente', 'assinado'];
      if (!statusPermitidos.includes(relatorio.status)) {
        return errorResponse(
          `Relatório não pode ser contestado no status atual: "${relatorio.status}". Status permitidos: ${statusPermitidos.join(', ')}`,
          400
        );
      }

      const ipAddress = getClientIp(request);

      await client.query('BEGIN');

      await client.query(
        `UPDATE bluepoint.bt_relatorios_mensais
         SET status = 'contestado', atualizado_em = NOW()
         WHERE id = $1`,
        [relatorioId]
      );

      const solicitacaoResult = await client.query(
        `INSERT INTO bt_solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'contestacao', $2, $3, $4, $5)
        RETURNING id`,
        [
          user.userId,
          `${relatorio.ano}-${String(relatorio.mes).padStart(2, '0')}-01`,
          data.motivo,
          data.justificativa || null,
          JSON.stringify({
            relatorioId,
            mes: relatorio.mes,
            ano: relatorio.ano,
            statusAnterior: relatorio.status,
            diasContestados: data.diasContestados || [],
          }),
        ]
      );

      await client.query('COMMIT');

      const solicitacaoId = solicitacaoResult.rows[0].id;

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'relatorios',
        descricao: `Contestação do relatório mensal ${relatorio.mes}/${relatorio.ano} (solicitação #${solicitacaoId})`,
        ip: ipAddress,
        userAgent: getUserAgent(request),
        dadosNovos: {
          relatorioId,
          solicitacaoId,
          motivo: data.motivo,
          diasContestados: data.diasContestados || [],
          statusAnterior: relatorio.status,
        },
      });

      return createdResponse({
        solicitacaoId,
        relatorioId,
        mensagem: 'Contestação registrada com sucesso. Aguarde a análise do gestor.',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao contestar relatório mensal:', error);
      return serverErrorResponse('Erro ao contestar relatório');
    } finally {
      client.release();
    }
  });
}
