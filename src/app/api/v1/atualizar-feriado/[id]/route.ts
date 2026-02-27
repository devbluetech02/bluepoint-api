import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { atualizarFeriadoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const feriadoId = parseInt(id);

      if (isNaN(feriadoId)) {
        return notFoundResponse('Feriado não encontrado');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarFeriadoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se existe
      const atualResult = await query(
        `SELECT * FROM bt_feriados WHERE id = $1`,
        [feriadoId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Feriado não encontrado');
      }

      // Atualizar
      await query(
        `UPDATE bt_feriados SET
          nome = COALESCE($1, nome),
          data = COALESCE($2, data),
          tipo = COALESCE($3, tipo),
          recorrente = COALESCE($4, recorrente),
          abrangencia = COALESCE($5, abrangencia),
          descricao = COALESCE($6, descricao),
          atualizado_em = NOW()
        WHERE id = $7`,
        [data.nome, data.data, data.tipo, data.recorrente, data.abrangencia, data.descricao, feriadoId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'feriados',
        descricao: `Feriado atualizado: ${data.nome || atualResult.rows[0].nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return successResponse({
        id: feriadoId,
        mensagem: 'Feriado atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar feriado:', error);
      return serverErrorResponse('Erro ao atualizar feriado');
    }
  });
}
