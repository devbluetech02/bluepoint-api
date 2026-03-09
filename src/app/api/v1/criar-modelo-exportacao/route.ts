import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';
import { z } from 'zod';

const criarModeloSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  descricao: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = criarModeloSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { nome, descricao } = validation.data;

      const result = await query(
        `INSERT INTO bluepoint.bt_modelos_exportacao (nome, descricao)
         VALUES ($1, $2)
         RETURNING id, nome, descricao, ativo, criado_em`,
        [nome, descricao || null]
      );

      const modelo = result.rows[0];

      await invalidateCache(CACHE_KEYS.MODELOS_EXPORTACAO);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'exportacao',
        descricao: `Modelo de exportação criado: ${modelo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: modelo.id, nome, descricao },
      });

      return createdResponse({
        id: modelo.id,
        nome: modelo.nome,
        descricao: modelo.descricao,
        ativo: modelo.ativo,
        criadoEm: modelo.criado_em,
      });
    } catch (error) {
      console.error('Erro ao criar modelo de exportação:', error);
      return serverErrorResponse('Erro ao criar modelo de exportação');
    }
  });
}
