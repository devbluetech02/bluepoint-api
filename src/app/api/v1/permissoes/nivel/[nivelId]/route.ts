import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAdmin, withGestor } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import {
  cacheAside,
  cacheDelPattern,
  CACHE_KEYS,
  CACHE_TTL,
} from '@/lib/cache';

// Níveis válidos: 1, 2 e 3 (corresponde a people.niveis_acesso.id)
const NIVEIS_VALIDOS = [1, 2, 3] as const;

function nivelValido(n: number): n is (typeof NIVEIS_VALIDOS)[number] {
  return (NIVEIS_VALIDOS as readonly number[]).includes(n);
}

// GET /api/v1/permissoes/nivel/:nivelId
// Lista todas as permissões com flag indicando se cada uma está concedida
// para o nível informado, agrupadas por módulo. Espelha o comportamento de
// /api/v1/permissoes/papel/:papel mas para a estrutura nova de níveis.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ nivelId: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { nivelId: nivelIdRaw } = await params;
      const nivelId = parseInt(nivelIdRaw, 10);

      if (!nivelValido(nivelId)) {
        return errorResponse(
          `Nível inválido. Use: ${NIVEIS_VALIDOS.join(', ')}`
        );
      }

      const data = await cacheAside(
        `${CACHE_KEYS.PAPEL_PERMISSOES}nivel:${nivelId}`,
        async () => {
          const todasResult = await query(
            `SELECT id, codigo, nome, descricao, modulo, acao
             FROM people.permissoes
             ORDER BY modulo, acao`
          );

          const vinculoResult = await query(
            `SELECT nap.permissao_id, nap.concedido
             FROM people.nivel_acesso_permissoes nap
             WHERE nap.nivel_id = $1`,
            [nivelId]
          );

          const concedidoMap = new Map<number, boolean>();
          for (const v of vinculoResult.rows) {
            concedidoMap.set(v.permissao_id, v.concedido);
          }

          interface PermissaoComFlag {
            id: number;
            codigo: string;
            nome: string;
            descricao: string;
            modulo: string;
            acao: string;
            concedido: boolean;
          }

          const permissoes: PermissaoComFlag[] = todasResult.rows.map((p) => ({
            id: p.id,
            codigo: p.codigo,
            nome: p.nome,
            descricao: p.descricao,
            modulo: p.modulo,
            acao: p.acao,
            concedido: concedidoMap.get(p.id) ?? false,
          }));

          const totalConcedidas = permissoes.filter((p) => p.concedido).length;

          const porModulo: Record<string, PermissaoComFlag[]> = {};
          for (const p of permissoes) {
            if (!porModulo[p.modulo]) porModulo[p.modulo] = [];
            porModulo[p.modulo].push(p);
          }

          const nivelInfoResult = await query(
            `SELECT id, nome, descricao FROM people.niveis_acesso WHERE id = $1`,
            [nivelId]
          );
          const nivelInfo = nivelInfoResult.rows[0] ?? null;

          return {
            nivel: nivelInfo
              ? {
                  id: nivelInfo.id,
                  nome: nivelInfo.nome,
                  descricao: nivelInfo.descricao,
                }
              : null,
            totalPermissoes: todasResult.rows.length,
            totalConcedidas,
            permissoes,
            porModulo,
          };
        },
        CACHE_TTL.MEDIUM
      );

      return successResponse(data);
    } catch (error) {
      console.error('Erro ao obter permissões do nível:', error);
      return serverErrorResponse('Erro ao obter permissões do nível');
    }
  });
}

// PUT /api/v1/permissoes/nivel/:nivelId
// Atualiza permissões concedidas para o nível. Espera body { permissoes: [{permissao_id, concedido}] }.
// Apenas admins (Nível 3 / tipo='admin') podem alterar.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ nivelId: string }> }
) {
  return withAdmin(request, async (_req: NextRequest, user: JWTPayload) => {
    try {
      const { nivelId: nivelIdRaw } = await params;
      const nivelId = parseInt(nivelIdRaw, 10);

      if (!nivelValido(nivelId)) {
        return errorResponse(
          `Nível inválido. Use: ${NIVEIS_VALIDOS.join(', ')}`
        );
      }

      const body = await request.json();
      const { permissoes } = body as {
        permissoes: { permissao_id: number; concedido: boolean }[];
      };

      if (!Array.isArray(permissoes)) {
        return errorResponse(
          'Campo "permissoes" deve ser um array de { permissao_id, concedido }'
        );
      }

      // god mode (userId === 1): API Keys (userId negativo) não podem ser
      // gravadas em atualizado_por. Usa null nesse caso.
      const atualizadoPor = user.userId > 0 ? user.userId : null;

      for (const p of permissoes) {
        await query(
          `INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido, atualizado_em, atualizado_por)
           VALUES ($1, $2, $3, NOW(), $4)
           ON CONFLICT (nivel_id, permissao_id)
           DO UPDATE SET concedido = $3, atualizado_em = NOW(), atualizado_por = $4`,
          [nivelId, p.permissao_id, p.concedido, atualizadoPor]
        );
      }

      // Invalidar cache de permissões — afeta /permissoes/usuario, /permissoes/papel,
      // /permissoes/nivel e a lista de níveis em si.
      await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);
      await cacheDelPattern(`${CACHE_KEYS.PERMISSOES}*`);

      const resultado = await query(
        `SELECT p.id, p.codigo, p.nome, p.modulo, p.acao, nap.concedido
         FROM people.nivel_acesso_permissoes nap
         JOIN people.permissoes p ON nap.permissao_id = p.id
         WHERE nap.nivel_id = $1
         ORDER BY p.modulo, p.acao`,
        [nivelId]
      );

      return successResponse({
        nivelId,
        totalConcedidas: resultado.rows.filter((r) => r.concedido).length,
        permissoes: resultado.rows,
      });
    } catch (error) {
      console.error('Erro ao atualizar permissões do nível:', error);
      return serverErrorResponse('Erro ao atualizar permissões do nível');
    }
  });
}
