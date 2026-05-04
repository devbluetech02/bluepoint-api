/**
 * Normalização canônica de nomes para matching cross-base entre People
 * (colaboradores) e Recrutamento (entrevistas_agendadas.recrutador,
 * candidatos.responsavel_entrevista). Usado pra:
 *
 *   - Persistir `recrutador_nome` em people.recrutador_avaliacao_ia
 *   - Comparar contra `user.nome` do JWT no GET /feedback-pendente
 *   - Filtrar contagens no cron-avaliacao-ia
 *
 * Regras (em ordem):
 *   1. Trim + colapsar whitespace
 *   2. UPPER
 *   3. Remover diacríticos (NFD + strip combining marks): JOÃO → JOAO
 *
 * Nome curto/composto invertido NÃO é tratado aqui — match permanece
 * exato. A invariância é só ortográfica (acentos + caixa + espaços).
 */
export function normalizarNomeRecrutador(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Fragmento SQL Postgres equivalente a `normalizarNomeRecrutador()`.
 * Usado quando a normalização precisa acontecer no banco (ex: GROUP BY
 * ou WHERE em queries da base de Recrutamento, onde o pg-driver não
 * pré-processa).
 *
 * Cobre os caracteres acentuados comuns em PT-BR. `unaccent()` seria
 * mais robusto mas exige extension habilitada — TRANSLATE puro é
 * portátil entre instâncias.
 */
export const SQL_NORMALIZE_NOME = (col: string): string => `
  TRANSLATE(
    UPPER(REGEXP_REPLACE(TRIM(${col}), '\\s+', ' ', 'g')),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
    'AAAAAEEEEIIIIOOOOOUUUUCAAAAAEEEEIIIIOOOOOUUUUC'
  )
`.replace(/\s+/g, ' ').trim();
