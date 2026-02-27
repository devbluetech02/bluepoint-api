import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { atualizarDepartamentoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateDepartamentoCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const departamentoId = parseInt(id);

      if (isNaN(departamentoId)) {
        return notFoundResponse('Departamento não encontrado');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarDepartamentoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se existe
      const atualResult = await query(
        `SELECT * FROM bt_departamentos WHERE id = $1`,
        [departamentoId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Departamento não encontrado');
      }

      const dadosAnteriores = atualResult.rows[0];

      // Atualizar
      await query(
        `UPDATE bt_departamentos SET
          nome = COALESCE($1, nome),
          descricao = COALESCE($2, descricao),
          gestor_id = COALESCE($3, gestor_id),
          status = COALESCE($4, status),
          atualizado_em = NOW()
        WHERE id = $5`,
        [data.nome, data.descricao, data.gestorId, data.status, departamentoId]
      );

      // Invalidar cache
      await invalidateDepartamentoCache(departamentoId);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'departamentos',
        descricao: `Departamento atualizado: ${data.nome || dadosAnteriores.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: departamentoId, nome: dadosAnteriores.nome },
        dadosNovos: { id: departamentoId, ...data },
      });

      return successResponse({
        id: departamentoId,
        mensagem: 'Departamento atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar departamento:', error);
      return serverErrorResponse('Erro ao atualizar departamento');
    }
  });
}
