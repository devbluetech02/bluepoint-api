import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor, isApiKeyAuth } from '@/lib/middleware';
import { resolverPendenciaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidatePendenciaCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    try {
      const { id } = await params;
      const pendenciaId = parseInt(id, 10);

      if (isNaN(pendenciaId)) {
        return notFoundResponse('Pendência não encontrada');
      }

      const body = await req.json();
      const validation = validateBody(resolverPendenciaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { status, observacao } = validation.data;
      await client.query('BEGIN');

      const pendenciaResult = await client.query(
        `SELECT *
         FROM people.pendencias
         WHERE id = $1`,
        [pendenciaId]
      );

      if (pendenciaResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFoundResponse('Pendência não encontrada');
      }

      const pendencia = pendenciaResult.rows[0];
      if (pendencia.status !== 'pendente') {
        await client.query('ROLLBACK');
        return errorResponse('Apenas pendências com status pendente podem ser resolvidas', 400);
      }

      const isAdmin = user.tipo === 'admin';
      const isDestinatario = !isApiKeyAuth(user) && pendencia.destinatario_id === user.userId;
      if (!isAdmin && !isDestinatario) {
        await client.query('ROLLBACK');
        return errorResponse('Apenas o destinatário da pendência ou admin pode resolvê-la', 403);
      }

      const resolvedBy = isApiKeyAuth(user) ? null : user.userId;
      const historyUser = isApiKeyAuth(user)
        ? (pendencia.destinatario_id ?? pendencia.criada_por_id ?? null)
        : user.userId;

      await client.query(
        `UPDATE people.pendencias SET
          status = $1,
          resolvida_por_id = $2,
          resolvido_em = NOW(),
          observacao_resolucao = $3,
          atualizado_em = NOW()
        WHERE id = $4`,
        [status, resolvedBy, observacao ?? null, pendenciaId]
      );

      await client.query(
        `INSERT INTO people.pendencias_historico (pendencia_id, status_anterior, status_novo, usuario_id, observacao)
         VALUES ($1, $2, $3, $4, $5)`,
        [pendenciaId, 'pendente', status, historyUser, observacao ?? null]
      );

      await client.query('COMMIT');

      await invalidatePendenciaCache(pendenciaId, pendencia.destinatario_id ?? undefined);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'resolver',
        modulo: 'pendencias',
        descricao: `Pendência resolvida: ${pendencia.titulo}`,
        entidadeId: pendenciaId,
        entidadeTipo: 'pendencia',
        dadosNovos: { pendenciaId, status, observacao: observacao ?? null },
      }));

      return successResponse({
        id: pendenciaId,
        status,
        mensagem: 'Pendência resolvida com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao resolver pendência:', error);
      return serverErrorResponse('Erro ao resolver pendência');
    } finally {
      client.release();
    }
  });
}
