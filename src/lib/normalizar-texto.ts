/**
 * Normalização de textos pessoais (nome, endereço, contato, dados
 * complementares). Política do sistema: tudo MAIÚSCULO, sem acentos,
 * sem caracteres especiais — facilita comparação, busca e padroniza
 * apresentação em relatórios/exportações.
 *
 * Regras:
 *   1. Trim + colapsar whitespace
 *   2. NFD + strip diacríticos (JOÃO → JOAO, ç → c)
 *   3. UPPER
 *   4. Remove caracteres não-alfanuméricos exceto espaço, hífen e ponto
 *      (útil pra coisas como "AV. BRASIL", "ED. CENTRAL", "RUA 7-A")
 *
 * Campos que NÃO devem usar este helper:
 *   - email (lowercase, case-sensitive em alguns provedores)
 *   - senha (nunca normalizar)
 *   - cpf, rg, cep, telefone (são só dígitos — usar regex \D)
 *   - chave PIX (varia por tipo: email/cpf/telefone/uuid)
 *   - IDs, códigos, URLs
 */
export function normalizarTextoPessoal(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  const t = String(input).trim();
  if (!t) return null;
  return t
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 \-.]/g, '');
}

/** Normaliza email — só lowercase + trim (mantém o resto). */
export function normalizarEmail(input: string | null | undefined): string | null {
  if (input == null) return null;
  const t = String(input).trim().toLowerCase();
  return t || null;
}

/** Mantém só dígitos (CPF, RG, telefone, CEP). */
export function soDigitos(input: string | null | undefined): string | null {
  if (input == null) return null;
  const t = String(input).replace(/\D/g, '');
  return t || null;
}
