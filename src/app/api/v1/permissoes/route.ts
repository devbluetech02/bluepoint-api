import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  createdResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAdmin, withGestor } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { cacheAside, cacheDelPattern, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// GET /api/v1/permissoes — Lista todas
export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const permissoes = await cacheAside(
        `${CACHE_KEYS.PERMISSOES}todas`,
        async () => {
          const result = await query(
            `SELECT id, codigo, nome, descricao, modulo, acao
             FROM bt_permissoes
             ORDER BY modulo, acao`
          );

          const porModulo: Record<string, typeof result.rows> = {};
          for (const row of result.rows) {
            if (!porModulo[row.modulo]) porModulo[row.modulo] = [];
            porModulo[row.modulo].push(row);
          }

          return { permissoes: result.rows, porModulo };
        },
        CACHE_TTL.LONG
      );

      return successResponse(permissoes);
    } catch (error) {
      console.error('Erro ao listar permissões:', error);
      return serverErrorResponse('Erro ao listar permissões');
    }
  });
}

// POST /api/v1/permissoes — Cria nova permissão no catálogo
export async function POST(request: NextRequest) {
  return withAdmin(request, async (_req: NextRequest, _user: JWTPayload) => {
    try {
      const body = await request.json();
      const { codigo, nome, descricao, modulo, acao } = body as {
        codigo?: string;
        nome?: string;
        descricao?: string;
        modulo?: string;
        acao?: string;
      };

      if (!codigo || !nome || !modulo || !acao) {
        return errorResponse(
          'Campos obrigatórios: codigo, nome, modulo, acao'
        );
      }

      const codigoEsperado = `${modulo}:${acao}`;
      if (codigo !== codigoEsperado) {
        return errorResponse(
          `O código deve seguir o padrão "modulo:acao". Esperado: "${codigoEsperado}"`
        );
      }

      const existente = await query(
        `SELECT id FROM bt_permissoes WHERE codigo = $1`,
        [codigo]
      );
      if (existente.rows.length > 0) {
        return errorResponse(`Já existe uma permissão com código "${codigo}"`, 409);
      }

      const result = await query(
        `INSERT INTO bt_permissoes (codigo, nome, descricao, modulo, acao)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, codigo, nome, descricao, modulo, acao, criado_em`,
        [codigo, nome, descricao || null, modulo, acao]
      );

      await cacheDelPattern(`${CACHE_KEYS.PERMISSOES}*`);
      await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);

      return createdResponse(result.rows[0]);
    } catch (error) {
      console.error('Erro ao criar permissão:', error);
      return serverErrorResponse('Erro ao criar permissão');
    }
  });
}
