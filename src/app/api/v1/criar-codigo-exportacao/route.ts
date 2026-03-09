import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';
import { z } from 'zod';

const criarCodigoSchema = z.object({
  modeloId: z.number().int().positive('modeloId deve ser um número positivo'),
  codigo: z.string().min(1, 'Código é obrigatório'),
  descricao: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = criarCodigoSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { modeloId, codigo, descricao } = validation.data;

      const modeloResult = await query(
        `SELECT id FROM bluepoint.bt_modelos_exportacao WHERE id = $1`,
        [modeloId]
      );

      if (modeloResult.rows.length === 0) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const result = await query(
        `INSERT INTO bluepoint.bt_codigos_exportacao (modelo_id, codigo, descricao)
         VALUES ($1, $2, $3)
         RETURNING id, modelo_id, codigo, descricao, status_arquivo, status_econtador, criado_em`,
        [modeloId, codigo, descricao || null]
      );

      const codigoExportacao = result.rows[0];

      await invalidateCache(CACHE_KEYS.MODELO_EXPORTACAO, modeloId);
      await invalidateCache(CACHE_KEYS.MODELOS_EXPORTACAO);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'exportacao',
        descricao: `Código de exportação criado: ${codigo} no modelo #${modeloId}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: codigoExportacao.id, modeloId, codigo, descricao },
      });

      return createdResponse({
        id: codigoExportacao.id,
        modeloId: codigoExportacao.modelo_id,
        codigo: codigoExportacao.codigo,
        descricao: codigoExportacao.descricao,
        statusArquivo: codigoExportacao.status_arquivo,
        statusEContador: codigoExportacao.status_econtador,
        criadoEm: codigoExportacao.criado_em,
      });
    } catch (error) {
      console.error('Erro ao criar código de exportação:', error);
      return serverErrorResponse('Erro ao criar código de exportação');
    }
  });
}
