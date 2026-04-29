/**
 * Escopo de gestão — quais departamentos e empresas um colaborador
 * (líder) gerencia. Substitui semanticamente o sistema antigo de
 * `liderancas_departamento` (arrays por tipo) com tabelas N:N limpas
 * acopladas ao redesenho de hierarquia em níveis.
 *
 * Regras:
 *   - Quem está em `gestor_empresas` para empresa X gerencia TODOS
 *     os colaboradores com `empresa_id = X`.
 *   - Quem está em `gestor_departamentos` para dept Y gerencia TODOS
 *     os colaboradores com `departamento_id = Y`.
 *   - Aditivamente, todo colaborador é "gestor natural" do próprio
 *     `departamento_id` (regra implícita aplicada aqui).
 *   - Super admin (userId === 1) tem escopo global — todos os departamentos
 *     e todas as empresas.
 *
 * O nível (cargos.nivel_acesso_id) define O QUE o gestor pode fazer;
 * estas funções definem ONDE.
 */

import { query } from './db';

export interface EscopoGestor {
  /** IDs de departamentos com gestão direta + o departamento próprio. */
  departamentoIds: number[];
  /** IDs de empresas com gestão direta. */
  empresaIds: number[];
}

/**
 * Carrega o escopo bruto de um colaborador (somente o que está nas
 * tabelas N:N + departamento próprio). Não expande empresas.
 */
export async function obterEscopoGestor(
  colaboradorId: number,
): Promise<EscopoGestor> {
  if (colaboradorId <= 0) {
    return { departamentoIds: [], empresaIds: [] };
  }

  const [proprioDept, depts, empresas] = await Promise.all([
    query<{ departamento_id: number | null }>(
      `SELECT departamento_id FROM people.colaboradores WHERE id = $1 LIMIT 1`,
      [colaboradorId],
    ),
    query<{ departamento_id: number }>(
      `SELECT departamento_id FROM people.gestor_departamentos
        WHERE colaborador_id = $1`,
      [colaboradorId],
    ),
    query<{ empresa_id: number }>(
      `SELECT empresa_id FROM people.gestor_empresas
        WHERE colaborador_id = $1`,
      [colaboradorId],
    ),
  ]);

  const departamentoIds = new Set<number>();
  if (proprioDept.rows[0]?.departamento_id != null) {
    departamentoIds.add(proprioDept.rows[0].departamento_id);
  }
  for (const r of depts.rows) departamentoIds.add(r.departamento_id);

  return {
    departamentoIds: Array.from(departamentoIds).sort((a, b) => a - b),
    empresaIds: empresas.rows.map((r) => r.empresa_id).sort((a, b) => a - b),
  };
}

/**
 * Retorna os IDs de colaboradores que estão dentro do escopo do gestor.
 * União de:
 *   - todos colaboradores com `empresa_id` em `escopo.empresaIds`
 *   - todos colaboradores com `departamento_id` em `escopo.departamentoIds`
 *
 * Aplica filtro adicional `apenasAtivos` (default true) e ordena por nome.
 */
export async function listarColaboradoresNoEscopo(
  escopo: EscopoGestor,
  options: { apenasAtivos?: boolean } = {},
): Promise<number[]> {
  const apenasAtivos = options.apenasAtivos ?? true;

  if (escopo.departamentoIds.length === 0 && escopo.empresaIds.length === 0) {
    return [];
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (escopo.departamentoIds.length > 0) {
    conditions.push(`departamento_id = ANY($${idx}::int[])`);
    params.push(escopo.departamentoIds);
    idx++;
  }
  if (escopo.empresaIds.length > 0) {
    conditions.push(`empresa_id = ANY($${idx}::int[])`);
    params.push(escopo.empresaIds);
    idx++;
  }

  const where = `(${conditions.join(' OR ')})${apenasAtivos ? ` AND status = 'ativo'` : ''}`;

  const r = await query<{ id: number }>(
    `SELECT id FROM people.colaboradores WHERE ${where} ORDER BY nome ASC`,
    params,
  );
  return r.rows.map((row) => row.id);
}

/**
 * Substitui o escopo de gestão de um colaborador. Idempotente:
 * apaga os vínculos atuais e insere os informados em uma transação.
 */
export async function definirEscopoGestor(
  colaboradorId: number,
  escopo: { departamentoIds: number[]; empresaIds: number[] },
  options: { atualizadoPor?: number | null } = {},
): Promise<void> {
  const atualizadoPor = options.atualizadoPor ?? null;
  const departamentoIds = Array.from(new Set(escopo.departamentoIds));
  const empresaIds = Array.from(new Set(escopo.empresaIds));

  await query('BEGIN', []);
  try {
    await query(
      `DELETE FROM people.gestor_departamentos WHERE colaborador_id = $1`,
      [colaboradorId],
    );
    await query(
      `DELETE FROM people.gestor_empresas WHERE colaborador_id = $1`,
      [colaboradorId],
    );

    if (departamentoIds.length > 0) {
      // INSERT em batch: gera ($1, $2, $4), ($1, $3, $4), ...
      const values: string[] = [];
      const params: unknown[] = [colaboradorId];
      for (const did of departamentoIds) {
        params.push(did);
        values.push(`($1, $${params.length}, $${departamentoIds.length + 2})`);
      }
      params.push(atualizadoPor);
      await query(
        `INSERT INTO people.gestor_departamentos
            (colaborador_id, departamento_id, criado_por)
         VALUES ${values.join(', ')}`,
        params,
      );
    }

    if (empresaIds.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [colaboradorId];
      for (const eid of empresaIds) {
        params.push(eid);
        values.push(`($1, $${params.length}, $${empresaIds.length + 2})`);
      }
      params.push(atualizadoPor);
      await query(
        `INSERT INTO people.gestor_empresas
            (colaborador_id, empresa_id, criado_por)
         VALUES ${values.join(', ')}`,
        params,
      );
    }

    await query('COMMIT', []);
  } catch (e) {
    await query('ROLLBACK', []);
    throw e;
  }
}

/**
 * Verifica se um gestor pode ver/agir sobre determinado colaborador.
 * Útil em endpoints de aprovação/listagem que precisam confirmar
 * autorização por escopo.
 */
export async function gestorPodeAcessarColaborador(
  gestorId: number,
  colaboradorId: number,
): Promise<boolean> {
  if (gestorId === colaboradorId) return true;

  // Carrega dept/empresa do alvo numa única query.
  const alvoR = await query<{
    departamento_id: number | null;
    empresa_id: number | null;
  }>(
    `SELECT departamento_id, empresa_id FROM people.colaboradores WHERE id = $1 LIMIT 1`,
    [colaboradorId],
  );
  const alvo = alvoR.rows[0];
  if (!alvo) return false;

  const escopo = await obterEscopoGestor(gestorId);
  if (alvo.departamento_id != null && escopo.departamentoIds.includes(alvo.departamento_id)) {
    return true;
  }
  if (alvo.empresa_id != null && escopo.empresaIds.includes(alvo.empresa_id)) {
    return true;
  }
  return false;
}
