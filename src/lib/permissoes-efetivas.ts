/**
 * Cálculo de permissões efetivas considerando os dois níveis de override:
 * por CARGO (migration 044) e por COLABORADOR/PESSOA (migration 050).
 * Override por colaborador tem precedência sobre o de cargo.
 *
 * Regra completa:
 *   permissões efetivas = (do nível do cargo)
 *                       ∪ (cargo_overrides com concedido = TRUE)
 *                       ∪ (colab_overrides com concedido = TRUE)
 *                       − (cargo_overrides com concedido = FALSE)
 *                       − (colab_overrides com concedido = FALSE)
 *
 * Resolução de conflito: como a UNION é ordenada (cargo antes de colab),
 * e a remoção é avaliada por NOT IN agrupando ambos os níveis, o
 * colab_override(true) prevalece sobre cargo_override(false) — pois
 * adiciona a permissão à base e só removemos via colab_override(false).
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

  return obterPermissoesEfetivasComColaborador({
    colaboradorId,
    cargoId: colab.cargo_id,
    nivelId: colab.nivel_acesso_id,
    tipoLegado: colab.tipo,
  });
}

/**
 * Versão completa: aplica override por colaborador sobre o resultado de
 * obterPermissoesEfetivasDoCargo.
 *
 * Retorna também `origem` mapeando cada código → fonte (`nivel` | `cargo`
 * | `pessoa`). Útil pra UI mostrar de onde a permissão vem.
 */
export async function obterPermissoesEfetivasComColaborador(args: {
  colaboradorId: number;
  cargoId: number | null;
  nivelId: number | null;
  tipoLegado?: string | null;
}): Promise<{
  codigos: string[];
  nivelId: number | null;
  cargoId: number | null;
  origem: Record<string, 'nivel' | 'cargo' | 'pessoa'>;
}> {
  const { colaboradorId, cargoId, nivelId, tipoLegado } = args;

  // Sem cargo/nivel: legado, ignora override individual.
  if (cargoId === null && nivelId === null) {
    const base = await obterPermissoesEfetivasDoCargo({ cargoId, nivelId, tipoLegado });
    const origem: Record<string, 'nivel' | 'cargo' | 'pessoa'> = {};
    for (const c of base.codigos) origem[c] = 'nivel';
    return { ...base, origem };
  }

  // Resolução em uma query: base (nivel + cargo_add + colab_add) menos
  // remoções (cargo_remove + colab_remove). Conflito colab_add vs
  // cargo_remove: colab_add prevalece (entra na base; só sai se
  // colab_remove existir explicitamente).
  const r = await query<{ codigo: string; origem: 'nivel' | 'cargo' | 'pessoa' }>(
    `WITH base AS (
       SELECT permissao_id, 'nivel'::text AS origem
         FROM people.nivel_acesso_permissoes
        WHERE nivel_id = $1 AND concedido = true
       UNION ALL
       SELECT permissao_id, 'cargo'::text AS origem
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = true
       UNION ALL
       SELECT permissao_id, 'pessoa'::text AS origem
         FROM people.colaborador_permissoes_override
        WHERE colaborador_id = $3 AND concedido = true
     ),
     remocoes_cargo AS (
       SELECT permissao_id
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = false
     ),
     remocoes_pessoa AS (
       SELECT permissao_id
         FROM people.colaborador_permissoes_override
        WHERE colaborador_id = $3 AND concedido = false
     ),
     ranked AS (
       -- Origem mais específica vence: pessoa > cargo > nivel.
       SELECT base.permissao_id,
              base.origem,
              ROW_NUMBER() OVER (
                PARTITION BY base.permissao_id
                ORDER BY CASE base.origem
                  WHEN 'pessoa' THEN 1
                  WHEN 'cargo'  THEN 2
                  ELSE 3 END
              ) AS rn
         FROM base
        WHERE base.permissao_id NOT IN (SELECT permissao_id FROM remocoes_pessoa)
          AND (
            base.origem = 'pessoa'  -- override pessoal sempre vale, mesmo se cargo remove
            OR base.permissao_id NOT IN (SELECT permissao_id FROM remocoes_cargo)
          )
     )
     SELECT p.codigo, ranked.origem
       FROM ranked
       JOIN people.permissoes p ON p.id = ranked.permissao_id
      WHERE ranked.rn = 1
      ORDER BY p.codigo`,
    [nivelId, cargoId, colaboradorId],
  );

  const origem: Record<string, 'nivel' | 'cargo' | 'pessoa'> = {};
  for (const row of r.rows) origem[row.codigo] = row.origem;
  return {
    codigos: r.rows.map((row) => row.codigo),
    nivelId,
    cargoId,
    origem,
  };
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
 * Verifica se um colaborador específico tem uma permissão (após overrides
 * de cargo e pessoais). Usado pelos middlewares `withPermission` /
 * `withAnyPermission`. Quando `colaboradorId` é null/inválido, cai no
 * `cargoTemPermissao` clássico.
 *
 * Override por pessoa(true) prevalece sobre cargo_override(false). Override
 * por pessoa(false) sempre remove.
 */
export async function colaboradorTemPermissao(
  colaboradorId: number | null,
  cargoId: number | null,
  nivelId: number | null,
  codigos: string[] | string,
): Promise<boolean> {
  const codigosArray = Array.isArray(codigos) ? codigos : [codigos];
  if (codigosArray.length === 0) return false;
  if (colaboradorId === null || colaboradorId <= 0) {
    return cargoTemPermissao(cargoId, nivelId, codigosArray);
  }
  if (cargoId === null && nivelId === null) return false;

  const r = await query<{ exists: boolean }>(
    `WITH base AS (
       SELECT permissao_id, 'n'::text AS o
         FROM people.nivel_acesso_permissoes
        WHERE nivel_id = $1 AND concedido = true
       UNION ALL
       SELECT permissao_id, 'c'::text AS o
         FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = true
       UNION ALL
       SELECT permissao_id, 'p'::text AS o
         FROM people.colaborador_permissoes_override
        WHERE colaborador_id = $3 AND concedido = true
     ),
     remocoes_cargo AS (
       SELECT permissao_id FROM people.cargo_permissoes_override
        WHERE cargo_id = $2 AND concedido = false
     ),
     remocoes_pessoa AS (
       SELECT permissao_id FROM people.colaborador_permissoes_override
        WHERE colaborador_id = $3 AND concedido = false
     )
     SELECT EXISTS(
       SELECT 1
         FROM people.permissoes p
         JOIN base ON base.permissao_id = p.id
        WHERE p.codigo = ANY($4::text[])
          AND p.id NOT IN (SELECT permissao_id FROM remocoes_pessoa)
          AND (
            base.o = 'p'
            OR p.id NOT IN (SELECT permissao_id FROM remocoes_cargo)
          )
     ) AS exists`,
    [nivelId, cargoId, colaboradorId, codigosArray],
  );
  return r.rows[0]?.exists === true;
}

/**
 * Verifica se um cargo concede uma permissão específica (após override
 * por cargo, sem considerar override pessoal). Mantido para casos onde
 * o cálculo é abstrato — "esse cargo tem X?". Para checagem de runtime
 * de um usuário concreto, prefira `colaboradorTemPermissao`.
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
