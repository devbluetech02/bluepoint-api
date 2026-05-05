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

/**
 * Normaliza um valor de campo conforme o tipo declarado no formulário.
 * Aplicado no momento em que o candidato envia o formulário de
 * pré-admissão e em qualquer endpoint que receba campos do colaborador
 * (criar-colaborador, atualizar-colaborador). Garante que o banco
 * persiste sempre o formato canônico — sem espaços extras, sem acentos,
 * em MAIÚSCULAS pra textos pessoais.
 *
 * Tipos especiais que NÃO são tocados (retorna o valor original):
 *   - photo, face_capture, signature, file (URLs/base64)
 *   - password (segredo)
 *   - exam_schedule (objeto estruturado)
 */
export function normalizarValorPorTipo(
  tipo: string,
  valor: unknown,
): unknown {
  if (valor == null) return valor;
  // Não-strings (objetos de exam_schedule, arrays, números, booleans) passam
  if (typeof valor !== 'string') return valor;

  const t = (tipo ?? '').toLowerCase();
  switch (t) {
    case 'photo':
    case 'face_capture':
    case 'signature':
    case 'file':
    case 'password':
    case 'senha':
    case 'exam_schedule':
      return valor;
    case 'email':
      return normalizarEmail(valor) ?? '';
    case 'cpf':
    case 'cnpj':
    case 'telefone':
    case 'phone':
    case 'cep':
      return soDigitos(valor) ?? '';
    case 'date':
    case 'datetime':
    case 'datetime-local':
      return valor.trim();
    case 'number':
    case 'numero': {
      // "Número" do endereço pode vir "123" ou "123-A". Mantém alfanumérico
      // + hífen, UPPER. Se for puramente numérico, fica igual.
      return valor
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9\-]/g, '');
    }
    default:
      // text, textarea, select, radio, qualquer outro → texto pessoal
      return normalizarTextoPessoal(valor) ?? '';
  }
}

/**
 * Normaliza todo o JSONB `dados` do formulário, usando o array `campos`
 * (vindo de `formularios_admissao.campos`) pra decidir tipo de cada
 * valor. Campos sem entrada correspondente em `campos` recebem
 * `normalizarTextoPessoal` por garantia (texto livre).
 */
export function normalizarDadosFormulario(
  campos: Array<{ id?: string | null; label: string; tipo: string }>,
  dados: Record<string, unknown>,
): Record<string, unknown> {
  const tipoPorChave = new Map<string, string>();
  for (const c of campos) {
    const tipo = c.tipo ?? 'text';
    if (c.id) tipoPorChave.set(c.id, tipo);
    if (c.label) tipoPorChave.set(c.label, tipo);
  }

  const out: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(dados)) {
    const tipo = tipoPorChave.get(chave) ?? 'text';
    out[chave] = normalizarValorPorTipo(tipo, valor);
  }
  return out;
}
