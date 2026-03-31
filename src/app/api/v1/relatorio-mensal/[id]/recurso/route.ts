import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateSolicitacaoCache } from '@/lib/cache';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

const recursoRelatorioSchema = z.object({
  colaboradorId: z.number().int().positive('colaboradorId é obrigatório'),
  motivo: z.string().min(5, 'Motivo deve ter no mínimo 5 caracteres'),
  diasContestados: z.array(
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD')
  ).min(1, 'Informe ao menos um dia contestado'),
  anexos: z.array(z.number().int().positive()).optional(),
});

async function gerarProtocolo(client: import('@/lib/db').PoolClient, ano: number): Promise<string> {
  const result = await client.query(
    `SELECT COUNT(*) as total
     FROM people.solicitacoes
     WHERE tipo = 'recurso_relatorio'
       AND EXTRACT(YEAR FROM data_solicitacao) = $1`,
    [ano]
  );
  const numero = parseInt(result.rows[0].total) + 1;
  return `REC-${ano}-${String(numero).padStart(4, '0')}`;
}

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
      const validation = validateBody(recursoRelatorioSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const relatorioResult = await query(
        `SELECT id, colaborador_id, mes, ano, status
         FROM people.relatorios_mensais
         WHERE id = $1`,
        [relatorioId]
      );

      if (relatorioResult.rows.length === 0) {
        return errorResponse('Relatório não encontrado', 404);
      }

      const relatorio = relatorioResult.rows[0];

      if (relatorio.colaborador_id !== data.colaboradorId) {
        return errorResponse('O relatório não pertence a este colaborador', 403);
      }

      if (relatorio.status !== 'pendente') {
        return errorResponse(
          `Recurso só pode ser aberto para relatórios com status "pendente". Status atual: ${relatorio.status}`,
          400
        );
      }

      await client.query('BEGIN');

      const anoAtual = new Date().getFullYear();
      const protocolo = await gerarProtocolo(client, anoAtual);

      const solicitacaoResult = await client.query(
        `INSERT INTO people.solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'recurso_relatorio', $2, $3, $4, $5)
        RETURNING id, tipo, status`,
        [
          data.colaboradorId,
          `${relatorio.ano}-${String(relatorio.mes).padStart(2, '0')}-01`,
          `Recurso relatório ${relatorio.mes}/${relatorio.ano}: ${data.motivo.substring(0, 100)}`,
          data.motivo,
          JSON.stringify({
            relatorioId,
            mes: relatorio.mes,
            ano: relatorio.ano,
            diasContestados: data.diasContestados,
            protocolo,
          }),
        ]
      );

      const solicitacao = solicitacaoResult.rows[0];

      await client.query(
        `INSERT INTO people.solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, $3)`,
        [solicitacao.id, user.userId, `Recurso aberto: ${protocolo}`]
      );

      if (data.anexos && data.anexos.length > 0) {
        for (const anexoId of data.anexos) {
          await client.query(
            `UPDATE people.anexos SET solicitacao_id = $1 WHERE id = $2 AND colaborador_id = $3`,
            [solicitacao.id, anexoId, data.colaboradorId]
          );
        }
      }

      await client.query(
        `UPDATE people.relatorios_mensais
         SET status = 'recurso', atualizado_em = NOW()
         WHERE id = $1`,
        [relatorioId]
      );

      await client.query('COMMIT');

      await invalidateSolicitacaoCache(undefined, data.colaboradorId);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'relatorios',
        descricao: `Recurso aberto para relatório mensal ${relatorio.mes}/${relatorio.ano} - ${protocolo}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          relatorioId,
          solicitacaoId: solicitacao.id,
          protocolo,
          diasContestados: data.diasContestados,
        },
      });

      return createdResponse({
        solicitacaoId: solicitacao.id,
        tipo: 'recurso_relatorio',
        status: 'pendente',
        protocolo,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao abrir recurso do relatório mensal:', error);
      return serverErrorResponse('Erro ao abrir recurso');
    } finally {
      client.release();
    }
  });
}
