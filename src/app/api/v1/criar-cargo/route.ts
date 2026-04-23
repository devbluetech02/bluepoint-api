import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { z } from 'zod';

const criarCargoSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  cbo: z.string().optional().nullable(),
  descricao: z.string().optional().nullable(),
  // diasTeste foi movido para usuarios_provisorios (task de 2026-04). Zod descarta
  // a chave silenciosamente se o cliente antigo ainda enviar — back-compat.
});

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = criarCargoSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { nome, cbo, descricao } = validation.data;

      const result = await query(
        `INSERT INTO people.cargos (nome, cbo, descricao)
         VALUES ($1, $2, $3)
         RETURNING id, nome`,
        [nome, cbo || null, descricao || null]
      );

      const cargo = result.rows[0];

      await invalidateCache(CACHE_KEYS.CARGOS);
      await embedTableRowAfterInsert('cargos', cargo.id);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'cargos',
        descricao: `Cargo criado: ${cargo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: cargo.id, nome, cbo, descricao },
      });

      return createdResponse({
        id: cargo.id,
        nome: cargo.nome,
        mensagem: 'Cargo criado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar cargo:', error);
      return serverErrorResponse('Erro ao criar cargo');
    }
  });
}
