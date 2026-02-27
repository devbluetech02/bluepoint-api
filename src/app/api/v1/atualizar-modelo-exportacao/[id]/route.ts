import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';
import { z } from 'zod';

const atualizarModeloSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres').optional(),
  descricao: z.string().optional().nullable(),
  ativo: z.boolean().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const modeloId = parseInt(id);

      if (isNaN(modeloId)) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const body = await req.json();

      const validation = atualizarModeloSchema.safeParse(body);
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
        `SELECT id, nome, descricao, ativo FROM bluepoint.bt_modelos_exportacao WHERE id = $1`,
        [modeloId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const modeloAntigo = existeResult.rows[0];
      const { nome, descricao, ativo } = validation.data;

      const updates: string[] = ['atualizado_em = NOW()'];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (nome !== undefined) {
        updates.push(`nome = $${paramIndex}`);
        values.push(nome);
        paramIndex++;
      }
      if (descricao !== undefined) {
        updates.push(`descricao = $${paramIndex}`);
        values.push(descricao);
        paramIndex++;
      }
      if (ativo !== undefined) {
        updates.push(`ativo = $${paramIndex}`);
        values.push(ativo);
        paramIndex++;
      }

      values.push(modeloId);

      const result = await query(
        `UPDATE bluepoint.bt_modelos_exportacao SET ${updates.join(', ')} WHERE id = $${paramIndex}
         RETURNING id, nome, descricao, ativo, atualizado_em`,
        values
      );

      const modelo = result.rows[0];

      await invalidateCache(CACHE_KEYS.MODELOS_EXPORTACAO);
      await invalidateCache(CACHE_KEYS.MODELO_EXPORTACAO, modeloId);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'exportacao',
        descricao: `Modelo de exportação atualizado: ${modelo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: modeloAntigo,
        dadosNovos: { nome, descricao, ativo },
      });

      return successResponse({
        id: modelo.id,
        nome: modelo.nome,
        descricao: modelo.descricao,
        ativo: modelo.ativo,
        atualizadoEm: modelo.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao atualizar modelo de exportação:', error);
      return serverErrorResponse('Erro ao atualizar modelo de exportação');
    }
  });
}
