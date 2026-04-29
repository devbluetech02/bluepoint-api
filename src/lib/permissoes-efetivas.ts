/**
 * Cálculo de permissões efetivas considerando o sistema de override
 * por cargo (migration 044). Substitui a leitura direta de
 * `nivel_acesso_permissoes` em todos os pontos que precisam saber
 * "quais permissões esse colaborador realmente tem".
 *
 * Regra:
 *   permissões efetivas = (do nível do cargo)
 *                       ∪ (overrides do cargo com concedido = TRUE)
 *                       − (overrides do cargo com concedido = FALSE)
 *
 * Sem cargo / sem nível: cai no comportamento legado de
 * `tipo_usuario_permissoes` (compat — vai sumir na Fase 4).
 */

import { query } from './db';

/**
 * Retorna lista de códigos de permissão efetivamente concedidos a um
 * colaborador, considerando: nível do cargo + overrides do cargo +
 * fallback ao tipo legado.
 *
 * `colaboradorId` deve ser o ID do colaborador (não API key — pra
 * API key, use o tipo da chave diretamente).
 */
export async function obterPermissoesEfetivasDoColaborador(
  colaboradorId: number,
): Promise<{
  codigos: string[];
  nivelId: number | null;
  cargoId: number | null;
}> {
  if (colaboradorId <= 0) {
    return { codigos: [], nivelId: null, cargoId: null };
  }

  // 1. Carrega tipo, cargo e nível do colaborador em uma query
  const colabResult = await query<{
    tipo: string;
    cargo_id: number | null;
    nivel_acesso_id: number | null;
  }>(
    `SELECT c.tipo::text AS tipo,
            c.cargo_id,
            cg.nivel_acesso_id
       FROM people.colaboradores c
       LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
      WHERE c.id = $1
      LIMIT 1`,
    [colaboradorId],
  );
  const colab = colabResult.rows[0];
  if (!colab) {
    return { codigos: [], nivelId: null, cargoId: null };
  }

  return obterPermissoesEfetivasDoCargo({
    cargoId: colab.cargo_id,
    nivelId: colab.nivel_acesso_id,
    tipoLegado: colab.tipo,
  });
}

/**
 * Versão "stateless" — recebe cargoId, nivelId e tipoLegado já carregados
 * (útil pro endpoint /autenticar que já pegou esses dados ao buscar o
 * colaborador no SELECT do login). Aplica a mesma regra de override.
 */
export async function obterPermissoesEfetivasDoCargo(args: {
  cargoId: number | null;
  nivelId: number | null;
  tipoLegado?: string | null;
}): Promise<{
  codigos: string[];
  nivelId: number | null;
  cargoId: number | null;
}> {
  const { cargoId, nivelId, tipoLegado } = args;

  // Se não tem cargo nem nível, cai no sistema legado (tipo_usuario_permissoes).
  if (cargoId === null && nivelId === null) {
    if (!tipoLegado) {
      return { codigos: [], nivelId: null, cargoId: null };
    }
    const r = await query<{ codigo: string }>(
      `SELECT DISTINCT p.codigo
         FROM people.tipo_usuario_permissoes tp
         JOIN people.permissoes p ON p.id = tp.permissao_id
        WHERE tp.tipo_usuario = $1 AND tp.concedido = true
        ORDER BY p.codigo`,
      [tipoLegado],
    );
    return { codigos: r.rows.map((row) => row.codigo), nivelId: null, cargoId: null };
  }

  // Estratégia única em SQL:
  //   - base: permissões do nível (concedidas)
  //   - + adições do override (concedido = TRUE)
  //   - − remoções do override (concedido = FALSE)
  // União feita por (id da permissão), depois trazemos código.
  const r = await query<{ codigo: string }>(
    `WITH base AS (
       SELECT permissao_id
         FROM people.nivel_acesso_permissoes
        WHERE nivel_id = $1 AND concedido = true
       UNION
       -- Adições do override sobrescrevem ausências da base
       SELECT permissao_id
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = true
     ),
     remocoes AS (
       SELECT permissao_id
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = false
     )
     SELECT DISTINCT p.codigo
       FROM people.permissoes p
       JOIN base ON base.permissao_id = p.id
      WHERE p.id NOT IN (SELECT permissao_id FROM remocoes)
      ORDER BY p.codigo`,
    [nivelId, cargoId],
  );
  return {
    codigos: r.rows.map((row) => row.codigo),
    nivelId,
    cargoId,
  };
}

/**
 * Verifica se um cargo concede uma permissão específica (após override).
 * Usado pelos middlewares `withPermission` / `withAnyPermission`.
 */
export async function cargoTemPermissao(
  cargoId: number | null,
  nivelId: number | null,
  codigos: string[] | string,
): Promise<boolean> {
  const codigosArray = Array.isArray(codigos) ? codigos : [codigos];
  if (codigosArray.length === 0) return false;
  if (cargoId === null && nivelId === null) return false;

  const r = await query<{ exists: boolean }>(
    `WITH base AS (
       SELECT permissao_id
         FROM people.nivel_acesso_permissoes
        WHERE nivel_id = $1 AND concedido = true
       UNION
       SELECT permissao_id
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = true
     ),
     remocoes AS (
       SELECT permissao_id
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = false
     )
     SELECT EXISTS(
       SELECT 1
         FROM people.permissoes p
         JOIN base ON base.permissao_id = p.id
        WHERE p.codigo = ANY($3::text[])
          AND p.id NOT IN (SELECT permissao_id FROM remocoes)
     ) AS exists`,
    [nivelId, cargoId, codigosArray],
  );
  return r.rows[0]?.exists === true;
}
