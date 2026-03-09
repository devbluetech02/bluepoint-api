import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';
import { z } from 'zod';

const atualizarCodigoSchema = z.object({
  codigo: z.string().min(1, 'Código é obrigatório').optional(),
  descricao: z.string().optional().nullable(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const codigoId = parseInt(id);

      if (isNaN(codigoId)) {
        return notFoundResponse('Código de exportação não encontrado');
      }

      const body = await req.json();

      const validation = atualizarCodigoSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const existeResult = await query(
        `SELECT id, modelo_id, codigo, descricao
         FROM bluepoint.bt_codigos_exportacao WHERE id = $1`,
        [codigoId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Código de exportação não encontrado');
      }

      const codigoAntigo = existeResult.rows[0];
      const { codigo, descricao } = validation.data;

      const updates: string[] = ['atualizado_em = NOW()'];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (codigo !== undefined) {
        updates.push(`codigo = $${paramIndex}`);
        values.push(codigo);
        paramIndex++;
      }
      if (descricao !== undefined) {
        updates.push(`descricao = $${paramIndex}`);
        values.push(descricao);
        paramIndex++;
      }

      values.push(codigoId);

      const result = await query(
        `UPDATE bluepoint.bt_codigos_exportacao SET ${updates.join(', ')} WHERE id = $${paramIndex}
         RETURNING id, modelo_id, codigo, descricao, status_arquivo, status_econtador, atualizado_em`,
        values
      );

      const codigoAtualizado = result.rows[0];

      await invalidateCache(CACHE_KEYS.MODELO_EXPORTACAO, codigoAtualizado.modelo_id);
      await invalidateCache(CACHE_KEYS.MODELOS_EXPORTACAO);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'exportacao',
        descricao: `Código de exportação atualizado: #${codigoId}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: codigoAntigo,
        dadosNovos: { codigo, descricao },
      });

      return successResponse({
        id: codigoAtualizado.id,
        modeloId: codigoAtualizado.modelo_id,
        codigo: codigoAtualizado.codigo,
        descricao: codigoAtualizado.descricao,
        statusArquivo: codigoAtualizado.status_arquivo,
        statusEContador: codigoAtualizado.status_econtador,
        atualizadoEm: codigoAtualizado.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao atualizar código de exportação:', error);
      return serverErrorResponse('Erro ao atualizar código de exportação');
    }
  });
}
