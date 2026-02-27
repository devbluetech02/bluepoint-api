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

const PAPEIS_VALIDOS = [
  'admin',
  'gestor',
  'gerente',
  'supervisor',
  'coordenador',
  'colaborador',
] as const;

function papelValido(
  papel: string
): papel is (typeof PAPEIS_VALIDOS)[number] {
  return (PAPEIS_VALIDOS as readonly string[]).includes(papel);
}

// GET /api/v1/permissoes/papel/:papel
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ papel: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { papel } = await params;

      if (!papelValido(papel)) {
        return errorResponse(
          `Papel inválido. Use: ${PAPEIS_VALIDOS.join(', ')}`
        );
      }

      const data = await cacheAside(
        `${CACHE_KEYS.PAPEL_PERMISSOES}${papel}`,
        async () => {
          const todasResult = await query(
            `SELECT id, codigo, nome, descricao, modulo, acao
             FROM bt_permissoes
             ORDER BY modulo, acao`
          );

          const vinculoResult = await query(
            `SELECT tp.permissao_id, tp.concedido
             FROM bt_tipo_usuario_permissoes tp
             WHERE tp.tipo_usuario = $1`,
            [papel]
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

          return {
            papel,
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
      console.error('Erro ao obter permissões do papel:', error);
      return serverErrorResponse('Erro ao obter permissões do papel');
    }
  });
}

// PUT /api/v1/permissoes/papel/:papel
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ papel: string }> }
) {
  return withAdmin(request, async (_req: NextRequest, user: JWTPayload) => {
    try {
      const { papel } = await params;

      if (!papelValido(papel)) {
        return errorResponse(
          `Papel inválido. Use: ${PAPEIS_VALIDOS.join(', ')}`
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

      for (const p of permissoes) {
        await query(
          `INSERT INTO bt_tipo_usuario_permissoes (tipo_usuario, permissao_id, concedido, atualizado_em, atualizado_por)
           VALUES ($1, $2, $3, NOW(), $4)
           ON CONFLICT (tipo_usuario, permissao_id)
           DO UPDATE SET concedido = $3, atualizado_em = NOW(), atualizado_por = $4`,
          [papel, p.permissao_id, p.concedido, user.userId]
        );
      }

      await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);
      await cacheDelPattern(`${CACHE_KEYS.PERMISSOES}*`);

      const resultado = await query(
        `SELECT p.id, p.codigo, p.nome, p.modulo, p.acao, tp.concedido
         FROM bt_tipo_usuario_permissoes tp
         JOIN bt_permissoes p ON tp.permissao_id = p.id
         WHERE tp.tipo_usuario = $1
         ORDER BY p.modulo, p.acao`,
        [papel]
      );

      return successResponse({
        papel,
        totalConcedidas: resultado.rows.filter((r) => r.concedido).length,
        permissoes: resultado.rows,
      });
    } catch (error) {
      console.error('Erro ao atualizar permissões do papel:', error);
      return serverErrorResponse('Erro ao atualizar permissões do papel');
    }
  });
}
