import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

// GET /api/v1/permissoes/:id — Obter uma permissão
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(request, async () => {
    try {
      const { id } = await params;
      const permissaoId = parseInt(id);

      if (isNaN(permissaoId)) {
        return errorResponse('ID inválido');
      }

      const result = await query(
        `SELECT id, codigo, nome, descricao, modulo, acao, criado_em
         FROM bt_permissoes WHERE id = $1`,
        [permissaoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Permissão não encontrada');
      }

      return successResponse(result.rows[0]);
    } catch (error) {
      console.error('Erro ao obter permissão:', error);
      return serverErrorResponse('Erro ao obter permissão');
    }
  });
}

// PUT /api/v1/permissoes/:id — Atualizar uma permissão
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(request, async (_req: NextRequest, _user: JWTPayload) => {
    try {
      const { id } = await params;
      const permissaoId = parseInt(id);

      if (isNaN(permissaoId)) {
        return errorResponse('ID inválido');
      }

      const existente = await query(
        `SELECT id FROM bt_permissoes WHERE id = $1`,
        [permissaoId]
      );
      if (existente.rows.length === 0) {
        return notFoundResponse('Permissão não encontrada');
      }

      const body = await request.json();
      const { nome, descricao } = body as {
        nome?: string;
        descricao?: string;
      };

      if (!nome && descricao === undefined) {
        return errorResponse('Informe ao menos "nome" ou "descricao"');
      }

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (nome) {
        setClauses.push(`nome = $${idx++}`);
        values.push(nome);
      }
      if (descricao !== undefined) {
        setClauses.push(`descricao = $${idx++}`);
        values.push(descricao);
      }

      values.push(permissaoId);

      const result = await query(
        `UPDATE bt_permissoes SET ${setClauses.join(', ')} WHERE id = $${idx}
         RETURNING id, codigo, nome, descricao, modulo, acao, criado_em`,
        values
      );

      await cacheDelPattern(`${CACHE_KEYS.PERMISSOES}*`);
      await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);

      return successResponse(result.rows[0]);
    } catch (error) {
      console.error('Erro ao atualizar permissão:', error);
      return serverErrorResponse('Erro ao atualizar permissão');
    }
  });
}

// DELETE /api/v1/permissoes/:id — Excluir uma permissão
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(request, async () => {
    try {
      const { id } = await params;
      const permissaoId = parseInt(id);

      if (isNaN(permissaoId)) {
        return errorResponse('ID inválido');
      }

      const existente = await query(
        `SELECT id, codigo FROM bt_permissoes WHERE id = $1`,
        [permissaoId]
      );
      if (existente.rows.length === 0) {
        return notFoundResponse('Permissão não encontrada');
      }

      await query(`DELETE FROM bt_permissoes WHERE id = $1`, [permissaoId]);

      await cacheDelPattern(`${CACHE_KEYS.PERMISSOES}*`);
      await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);

      return successResponse({
        id: permissaoId,
        codigo: existente.rows[0].codigo,
        mensagem: 'Permissão excluída com sucesso',
      });
    } catch (error) {
      console.error('Erro ao excluir permissão:', error);
      return serverErrorResponse('Erro ao excluir permissão');
    }
  });
}
