// =====================================================
// Classificação automática de tipo de documento da pré-admissão
// =====================================================
//
// Quando o candidato anexa documentos no formulário de pré-admissão,
// o tipo (CNH, ASO, EPI, etc.) é definido pelo CAMPO do formulário —
// que o admin configurou. Mas na prática:
//   - Campos genéricos ("Documento de Identificação") não têm tipo correto
//   - Candidato pode anexar arquivo errado no campo certo
//   - Comprovantes de endereço, contratos, etc. não têm tipo específico
//     na lista de `tipos_documento_colaborador` e ficam órfãos
//
// Esta lib usa o Claude (via OpenRouter) para reclassificar cada documento
// no momento da admissão, baseando-se em:
//   - Nome do arquivo (ex.: "cnh_frente.pdf", "comprovante_residencia.pdf")
//   - Label do campo do formulário onde foi anexado
//   - Lista dos tipos disponíveis no banco
//
// Estratégia text-only (não baixa o conteúdo do arquivo): resolve ~90% dos
// casos onde o nome/label tem contexto suficiente. Para os 10% restantes,
// fallback para 'outros' (que é o tipo "guarda-chuva" do colaborador).
//
// Uso:
//   const codigo = await classificarTipoDocumento({
//     nomeArquivo: 'cnh_frente.pdf',
//     labelCampo: 'Documento de Identificação',
//     tiposDisponiveis: [{ codigo: 'cnh', nomeExibicao: 'CNH' }, ...],
//   });
//   // → 'cnh' | 'aso' | 'epi' | 'direcao_defensiva' | 'nr35' | 'outros'

import { extractJson, openRouterChat } from './openrouter';

export interface TipoDocumentoCandidato {
  id: number;
  codigo: string;
  nomeExibicao: string;
}

export interface ClassificarDocumentoInput {
  nomeArquivo: string;
  labelCampo?: string | null;
  tipoOriginalCodigo?: string | null;
  tiposDisponiveis: TipoDocumentoCandidato[];
}

/** Resposta esperada do modelo, parseada via JSON. */
interface RespostaIA {
  codigo: string;
  confianca: 'alta' | 'media' | 'baixa';
  motivo?: string;
}

/**
 * Classifica o documento via Claude. Retorna o `codigo` de um dos tipos em
 * `tiposDisponiveis`. Em caso de qualquer falha (timeout, key ausente,
 * resposta inválida), retorna 'outros' — sempre garantindo que o documento
 * seja persistido no colaborador.
 */
export async function classificarTipoDocumento(
  input: ClassificarDocumentoInput,
): Promise<string> {
  const codigosValidos = new Set(input.tiposDisponiveis.map((t) => t.codigo));
  const fallback = codigosValidos.has('outros') ? 'outros' : input.tiposDisponiveis[0]?.codigo;
  if (!fallback) return 'outros';

  // Atalho: se o nome do arquivo OU o label têm o código exato no nome,
  // confia direto sem chamar a IA. Economiza tokens em casos óbvios.
  const heuristica = classificarPorHeuristica(input, codigosValidos);
  if (heuristica) return heuristica;

  const tiposLista = input.tiposDisponiveis
    .map((t) => `- ${t.codigo}: ${t.nomeExibicao}`)
    .join('\n');

  const contexto = [
    `Nome do arquivo: ${input.nomeArquivo}`,
    input.labelCampo ? `Label do campo no formulário: ${input.labelCampo}` : null,
    input.tipoOriginalCodigo ? `Tipo originalmente atribuído: ${input.tipoOriginalCodigo}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `Você é um classificador de documentos de RH brasileiro. Classifique o documento abaixo em UM dos tipos disponíveis.

Tipos disponíveis (use exatamente o código entre os listados):
${tiposLista}

Documento:
${contexto}

Regras:
- Se o nome ou label sugerir CNH (carteira de motorista, habilitação, "cnh", etc.) → "cnh"
- Se sugerir ASO (atestado de saúde ocupacional, exame admissional) → "aso"
- Se sugerir EPI (equipamento de proteção, ficha de EPI, ASO de EPI) → "epi"
- Se sugerir treinamento de direção defensiva → "direcao_defensiva"
- Se sugerir NR-35 (trabalho em altura, treinamento NR35) → "nr35"
- Documentos genéricos (RG, CPF, comprovante de endereço, certidões, contratos, foto, carteira de trabalho, PIS, etc.) → "outros"
- Quando em dúvida, prefira "outros" ao invés de chutar um tipo específico.

Responda APENAS com JSON puro, sem cercas markdown:
{"codigo":"<um dos códigos>","confianca":"alta|media|baixa","motivo":"<frase curta>"}`;

  const result = await openRouterChat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.1, maxTokens: 200, responseFormatJson: true, timeoutMs: 20_000 },
  );

  if (!result.ok) {
    console.warn(`[classificar-doc] IA falhou (${result.reason}) para "${input.nomeArquivo}" — fallback ${fallback}`);
    return fallback;
  }

  const parsed = extractJson<RespostaIA>(result.content);
  if (!parsed || typeof parsed.codigo !== 'string') {
    console.warn(`[classificar-doc] resposta inválida para "${input.nomeArquivo}" — fallback ${fallback}`);
    return fallback;
  }

  const codigo = parsed.codigo.trim().toLowerCase();
  if (!codigosValidos.has(codigo)) {
    console.warn(`[classificar-doc] código "${codigo}" não está em [${[...codigosValidos].join(',')}] — fallback ${fallback}`);
    return fallback;
  }

  return codigo;
}

/**
 * Heurística rápida (sem chamar IA): se o nome do arquivo ou label do campo
 * contém o código de um tipo de forma inequívoca, retorna direto. Não cobre
 * casos ambíguos (ex.: "documento.pdf" não retorna nada — IA decide).
 */
function classificarPorHeuristica(
  input: ClassificarDocumentoInput,
  codigosValidos: Set<string>,
): string | null {
  const haystack = `${input.nomeArquivo} ${input.labelCampo ?? ''}`.toLowerCase();

  const padroes: Array<{ codigo: string; needles: string[] }> = [
    { codigo: 'cnh', needles: ['cnh', 'carteira nacional', 'habilitação', 'habilitacao', 'carteira de motorista'] },
    { codigo: 'aso', needles: ['aso', 'atestado de saúde', 'atestado de saude', 'exame admissional'] },
    { codigo: 'direcao_defensiva', needles: ['direção defensiva', 'direcao defensiva', 'defensiva'] },
    { codigo: 'nr35', needles: ['nr35', 'nr-35', 'nr 35', 'trabalho em altura'] },
    { codigo: 'epi', needles: ['ficha epi', 'ficha de epi', 'epi -', 'controle de epi'] },
  ];

  for (const p of padroes) {
    if (!codigosValidos.has(p.codigo)) continue;
    if (p.needles.some((n) => haystack.includes(n))) return p.codigo;
  }
  return null;
}
