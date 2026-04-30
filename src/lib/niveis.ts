/**
 * Constantes de níveis de acesso. Single source of truth — usar em vez
 * de magic numbers (`nivelId >= 2`, `>= 3`) espalhados pelos middlewares.
 *
 * Definidos pela migration 040_niveis_acesso.sql:
 *   1 = Colaborador básico (vê apenas próprios dados)
 *   2 = Gestor (vê escopo: departamentos/empresas atribuídas)
 *   3 = Admin (acesso total)
 */
export const NIVEL_COLABORADOR = 1 as const;
export const NIVEL_GESTOR = 2 as const;
export const NIVEL_ADMIN = 3 as const;

export type NivelId = typeof NIVEL_COLABORADOR | typeof NIVEL_GESTOR | typeof NIVEL_ADMIN;

export function isGestor(nivelId: number | null | undefined): boolean {
  return nivelId != null && nivelId >= NIVEL_GESTOR;
}

export function isAdmin(nivelId: number | null | undefined): boolean {
  return nivelId != null && nivelId >= NIVEL_ADMIN;
}
