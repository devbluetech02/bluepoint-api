import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  createdResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAuth, withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { z } from 'zod';

type ExameRow = { id: number; nome: string };

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const result = await query(
        `SELECT id, nome
         FROM people.exames
         WHERE ativo = TRUE
         ORDER BY nome ASC`,
        []
      );

      const exames = (result.rows as ExameRow[]).map((e) => ({
        id: e.id,
        nome: e.nome,
      }));

      return successResponse({ exames });
    } catch (error) {
      console.error('Erro ao listar exames:', error);
      return serverErrorResponse('Erro ao listar exames');
    }
  });
}

const criarExameSchema = z.object({
  nome: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(2, 'Nome deve ter pelo menos 2 caracteres').max(100, 'Nome deve ter no máximo 100 caracteres')),
});

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = criarExameSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach((issue) => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { nome } = validation.data;

      const existente = await query(
        `SELECT id, nome FROM people.exames WHERE LOWER(nome) = LOWER($1) LIMIT 1`,
        [nome]
      );

      if (existente.rows.length > 0) {
        const exame = existente.rows[0] as ExameRow;
        return successResponse({ exame: { id: exame.id, nome: exame.nome } });
      }

      const result = await query(
        `INSERT INTO people.exames (nome) VALUES ($1) RETURNING id, nome`,
        [nome]
      );
      const exame = result.rows[0] as ExameRow;

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'criar',
          modulo: 'cargos',
          descricao: `Exame criado no catálogo: ${exame.nome}`,
          entidadeId: exame.id,
          entidadeTipo: 'exame',
          dadosNovos: { id: exame.id, nome: exame.nome },
        })
      );

      return createdResponse({ exame: { id: exame.id, nome: exame.nome } });
    } catch (error) {
      console.error('Erro ao criar exame:', error);
      return serverErrorResponse('Erro ao criar exame');
    }
  });
}
