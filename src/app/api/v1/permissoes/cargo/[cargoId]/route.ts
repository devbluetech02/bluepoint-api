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

// =====================================================
// /api/v1/permissoes/cargo/:cargoId
// =====================================================
//
// GET — Lista todas as permissões com 4 estados pra UI editar:
//   - 'herdada'    → vem do nível do cargo (sem override) → concedida
//   - 'adicionada' → override concedido=true (extra além do nível)
//   - 'removida'   → override concedido=false (revogada do que vinha do nível)
//   - 'nao'        → nem o nível dá nem tem override (não concedida)
//
// PUT — Atualiza overrides. Body: { permissoes: [{permissao_id, estado}] }
// Onde estado ∈ 'herdada' | 'adicionada' | 'removida' | 'nao'.
// O backend converte o estado pro override certo (ou apaga a linha de
// override quando o estado escolhido coincide com o que o nível já dá).

const ESTADOS_VALIDOS = ['herdada', 'adicionada', 'removida', 'nao'] as const;
type Estado = (typeof ESTADOS_VALIDOS)[number];

function estadoValido(s: string): s is Estado {
  return (ESTADOS_VALIDOS as readonly string[]).includes(s);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cargoId: string }> },
) {
  return withGestor(request, async () => {
    try {
      const { cargoId: cargoIdRaw } = await params;
      const cargoId = parseInt(cargoIdRaw, 10);
      if (Number.isNaN(cargoId) || cargoId <= 0) {
        return errorResponse('cargoId inválido', 400);
      }

      const data = await cacheAside(
        `${CACHE_KEYS.PAPEL_PERMISSOES}cargo:${cargoId}`,
        async () => {
          // Cargo + nível.
          const cargoRes = await query<{
            id: number;
            nome: string;
            nivel_acesso_id: number | null;
            nivel_nome: string | null;
            nivel_descricao: string | null;
          }>(
            `SELECT cg.id, cg.nome, cg.nivel_acesso_id,
                    n.nome AS nivel_nome, n.descricao AS nivel_descricao
               FROM people.cargos cg
               LEFT JOIN people.niveis_acesso n ON n.id = cg.nivel_acesso_id
              WHERE cg.id = $1
              LIMIT 1`,
            [cargoId],
          );
          if (cargoRes.rows.length === 0) return null;
          const cargo = cargoRes.rows[0];

          const todasRes = await query(
            `SELECT id, codigo, nome, descricao, modulo, acao
               FROM people.permissoes
              ORDER BY modulo, acao`,
          );

          // Base: o que o nível concede.
          const baseRes = cargo.nivel_acesso_id
            ? await query<{ permissao_id: number }>(
                `SELECT permissao_id
                   FROM people.nivel_acesso_permissoes
                  WHERE nivel_id = $1 AND concedido = true`,
                [cargo.nivel_acesso_id],
              )
            : { rows: [] as { permissao_id: number }[] };
          const baseSet = new Set(baseRes.rows.map((r) => r.permissao_id));

          // Overrides.
          const ovRes = await query<{ permissao_id: number; concedido: boolean }>(
            `SELECT permissao_id, concedido
               FROM people.cargo_permissoes_override
              WHERE cargo_id = $1`,
            [cargoId],
          );
          const overrideMap = new Map<number, boolean>();
          for (const r of ovRes.rows) overrideMap.set(r.permissao_id, r.concedido);

          interface PermissaoComEstado {
            id: number;
            codigo: string;
            nome: string;
            descricao: string;
            modulo: string;
            acao: string;
            estado: Estado;
            concedida: boolean;
          }

          const permissoes: PermissaoComEstado[] = todasRes.rows.map((p) => {
            const naBase = baseSet.has(p.id);
            const ov = overrideMap.get(p.id);
            let estado: Estado;
            if (ov === true) estado = 'adicionada';
            else if (ov === false) estado = 'removida';
            else estado = naBase ? 'herdada' : 'nao';
            const concedida = estado === 'herdada' || estado === 'adicionada';
            return {
              id: p.id,
              codigo: p.codigo,
              nome: p.nome,
              descricao: p.descricao,
              modulo: p.modulo,
              acao: p.acao,
              estado,
              concedida,
            };
          });

          const porModulo: Record<string, PermissaoComEstado[]> = {};
          for (const p of permissoes) {
            if (!porModulo[p.modulo]) porModulo[p.modulo] = [];
            porModulo[p.modulo].push(p);
          }

          return {
            cargo: {
              id: cargo.id,
              nome: cargo.nome,
              nivel: cargo.nivel_acesso_id
                ? {
                    id: cargo.nivel_acesso_id,
                    nome: cargo.nivel_nome,
                    descricao: cargo.nivel_descricao,
                  }
                : null,
            },
            totalPermissoes: permissoes.length,
            totalConcedidas: permissoes.filter((p) => p.concedida).length,
            totalAdicionadas: permissoes.filter((p) => p.estado === 'adicionada').length,
            totalRemovidas: permissoes.filter((p) => p.estado === 'removida').length,
            permissoes,
            porModulo,
          };
        },
        CACHE_TTL.MEDIUM,
      );

      if (data === null) return errorResponse('Cargo não encontrado', 404);
      return successResponse(data);
    } catch (error) {
      console.error('Erro ao obter permissões do cargo:', error);
      return serverErrorResponse('Erro ao obter permissões do cargo');
    }
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ cargoId: string }> },
) {
  return withAdmin(request, async (_req: NextRequest, user: JWTPayload) => {
    try {
      const { cargoId: cargoIdRaw } = await params;
      const cargoId = parseInt(cargoIdRaw, 10);
      if (Number.isNaN(cargoId) || cargoId <= 0) {
        return errorResponse('cargoId inválido', 400);
      }

      const body = await request.json();
      const { permissoes } = body as {
        permissoes: { permissao_id: number; estado: string }[];
      };
      if (!Array.isArray(permissoes)) {
        return errorResponse(
          'Campo "permissoes" deve ser array de { permissao_id, estado }',
          400,
        );
      }

      // Carrega nível do cargo pra saber o que está na base.
      const cargoRes = await query<{ nivel_acesso_id: number | null }>(
        `SELECT nivel_acesso_id FROM people.cargos WHERE id = $1 LIMIT 1`,
        [cargoId],
      );
      if (cargoRes.rows.length === 0) {
        return errorResponse('Cargo não encontrado', 404);
      }
      const nivelId = cargoRes.rows[0].nivel_acesso_id;

      // Set de permissões que o nível concede.
      const baseSet = new Set<number>();
      if (nivelId !== null) {
        const baseRes = await query<{ permissao_id: number }>(
          `SELECT permissao_id
             FROM people.nivel_acesso_permissoes
            WHERE nivel_id = $1 AND concedido = true`,
          [nivelId],
        );
        for (const r of baseRes.rows) baseSet.add(r.permissao_id);
      }

      const atualizadoPor = user.userId > 0 ? user.userId : null;

      for (const p of permissoes) {
        if (!estadoValido(p.estado)) continue;
        const naBase = baseSet.has(p.permissao_id);

        // Decide se mantém override e qual valor.
        // - 'adicionada': override TRUE (extra além do nível).
        //   Se a permissão JÁ vem da base, override TRUE é redundante mas
        //   mantemos pra refletir intenção do admin (só bagunça se nível mudar
        //   e a remoção implícita foi proposital). Optamos por simplificar:
        //   se naBase → marca como 'herdada' (apaga override), senão → TRUE.
        // - 'removida': override FALSE. Se naBase → grava (faz sentido).
        //   Se não naBase → redundante; apaga.
        // - 'herdada': estado = base do nível. Apaga override.
        // - 'nao': não concedida. Se naBase → grava override FALSE.
        //   Se não naBase → apaga override (já era 'nao' por default).
        let novoOverride: boolean | null = null; // null = apagar linha
        switch (p.estado as Estado) {
          case 'adicionada':
            novoOverride = naBase ? null : true;
            break;
          case 'removida':
            novoOverride = naBase ? false : null;
            break;
          case 'herdada':
            novoOverride = null;
            break;
          case 'nao':
            novoOverride = naBase ? false : null;
            break;
        }

        if (novoOverride === null) {
          await query(
            `DELETE FROM people.cargo_permissoes_override
              WHERE cargo_id = $1 AND permissao_id = $2`,
            [cargoId, p.permissao_id],
          );
        } else {
          await query(
            `INSERT INTO people.cargo_permissoes_override
                  (cargo_id, permissao_id, concedido, atualizado_em, atualizado_por)
             VALUES ($1, $2, $3, NOW(), $4)
             ON CONFLICT (cargo_id, permissao_id)
             DO UPDATE SET concedido = $3,
                           atualizado_em = NOW(),
                           atualizado_por = $4`,
            [cargoId, p.permissao_id, novoOverride, atualizadoPor],
          );
        }
      }

      await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);
      await cacheDelPattern(`${CACHE_KEYS.PERMISSOES}*`);

      return successResponse({ cargoId, atualizado: true });
    } catch (error) {
      console.error('Erro ao atualizar permissões do cargo:', error);
      return serverErrorResponse('Erro ao atualizar permissões do cargo');
    }
  });
}
