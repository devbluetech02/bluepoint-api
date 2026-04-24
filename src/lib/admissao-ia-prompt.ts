import { OpenRouterMessage } from './openrouter';

export interface CampoFormInfo {
  id: string;
  label: string;
  tipo?: string | null;
  obrigatorio?: boolean;
  valor: string;
}

export interface DocumentoEnviadoInfo {
  tipoId: number;
  tipoNome: string;
  nomeArquivo: string;
}

export interface AnaliseIaAnterior {
  quando: Date;
  acao: string;
  motivo: string | null;
  camposProblema: string[];
  documentosProblema: number[];
}

export interface PromptContext {
  candidatoNome: string;
  candidatoCpf: string;
  cargo: string;
  campos: CampoFormInfo[];
  documentosEnviados: DocumentoEnviadoInfo[];
  documentosObrigatorios: { tipoId: number; tipoNome: string }[];
  analisesAnteriores: AnaliseIaAnterior[];
}

export interface DecisaoIa {
  acao: 'solicitar_correcao' | 'ok_para_aso' | 'escalar_humano';
  motivo: string;
  camposComProblema: string[];
  documentosComProblema: number[];
}

export function buildPromptMessages(ctx: PromptContext): OpenRouterMessage[] {
  const system = `Você é um(a) analista de Departamento Pessoal (DP) muito experiente no Brasil.
Sua tarefa é revisar os dados e documentos de um candidato que preencheu o formulário de pré-admissão e decidir uma das três ações abaixo.

AÇÕES POSSÍVEIS:
1. "solicitar_correcao" — se encontrar qualquer dado faltando, inconsistente, formato errado, ou documento obrigatório não enviado. Liste EXATAMENTE os IDs dos campos e os tipo_id dos documentos que precisam de correção.
2. "ok_para_aso" — se TUDO estiver correto e completo. O candidato está pronto para o próximo passo (agendamento do ASO pelo DP humano).
3. "escalar_humano" — se houver ambiguidade, caso raro, ou você não tem certeza. Use isso com parcimônia.

REGRAS CRÍTICAS:
- Seja direto: campo vazio obrigatório = problema. Formato de CPF errado (não é 11 dígitos) = problema. Documento obrigatório sem upload = problema.
- NÃO reclame de dados opcionais vazios.
- NÃO invente problemas — só reporte o que você consegue justificar olhando os dados.
- Se uma análise anterior JÁ pediu correção do mesmo item, considere "escalar_humano" (o candidato pode estar travado e o DP precisa intervir diretamente).
- Seja breve no motivo (1-2 frases objetivas).

FORMATO DE RESPOSTA — apenas JSON puro, sem markdown, sem prefácio:
{
  "acao": "solicitar_correcao" | "ok_para_aso" | "escalar_humano",
  "motivo": "explicação curta do porquê da decisão",
  "camposComProblema": ["id_do_campo_1", "id_do_campo_2"],
  "documentosComProblema": [tipo_doc_id1, tipo_doc_id2]
}

Se escolher "ok_para_aso" ou "escalar_humano", devolva camposComProblema e documentosComProblema como arrays vazios.`;

  const camposDescricao = ctx.campos.length === 0
    ? '(nenhum campo no formulário)'
    : ctx.campos.map(c => {
        const obrig = c.obrigatorio ? ' [obrigatório]' : '';
        const tipo = c.tipo ? ` <${c.tipo}>` : '';
        const valor = c.valor.trim() === '' ? '(vazio)' : c.valor;
        return `- id=${c.id} | ${c.label}${tipo}${obrig}\n  valor: ${valor}`;
      }).join('\n');

  const docsEnviados = ctx.documentosEnviados.length === 0
    ? '(nenhum documento enviado)'
    : ctx.documentosEnviados.map(d =>
        `- tipo_id=${d.tipoId} (${d.tipoNome}) — arquivo: ${d.nomeArquivo}`
      ).join('\n');

  const docsObrig = ctx.documentosObrigatorios.length === 0
    ? '(nenhum documento obrigatório configurado)'
    : ctx.documentosObrigatorios.map(d =>
        `- tipo_id=${d.tipoId} (${d.tipoNome})`
      ).join('\n');

  const historico = ctx.analisesAnteriores.length === 0
    ? '(primeira análise desta solicitação)'
    : ctx.analisesAnteriores.map((a, i) => {
        const data = a.quando.toISOString().slice(0, 16).replace('T', ' ');
        const campos = a.camposProblema.length === 0 ? '-' : a.camposProblema.join(', ');
        const docs = a.documentosProblema.length === 0 ? '-' : a.documentosProblema.join(', ');
        return `${i + 1}. [${data}] ação=${a.acao} | motivo: ${a.motivo ?? '(sem motivo)'}\n   campos flaggados: ${campos}\n   docs flaggados: ${docs}`;
      }).join('\n');

  const user = `CANDIDATO
Nome: ${ctx.candidatoNome || '(não informado)'}
CPF: ${ctx.candidatoCpf || '(não informado)'}
Cargo pretendido: ${ctx.cargo || '(não informado)'}

DADOS DO FORMULÁRIO DE ADMISSÃO
${camposDescricao}

DOCUMENTOS OBRIGATÓRIOS ESPERADOS
${docsObrig}

DOCUMENTOS QUE O CANDIDATO ENVIOU
${docsEnviados}

HISTÓRICO DE ANÁLISES IA ANTERIORES (mais recentes primeiro)
${historico}

Decida. Responda APENAS o JSON.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Valida e normaliza a resposta da IA.
 * Retorna null se a estrutura é inválida.
 */
export function parseDecisao(obj: unknown): DecisaoIa | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const acaoRaw = (o.acao ?? o.action ?? '').toString();
  if (!['solicitar_correcao', 'ok_para_aso', 'escalar_humano'].includes(acaoRaw)) {
    return null;
  }
  const acao = acaoRaw as DecisaoIa['acao'];

  const motivo = (o.motivo ?? o.reason ?? '').toString().trim();

  const camposRaw = o.camposComProblema ?? o.campos_com_problema ?? [];
  const campos = Array.isArray(camposRaw)
    ? camposRaw.map(v => v?.toString() ?? '').filter(s => s.length > 0)
    : [];

  const docsRaw = o.documentosComProblema ?? o.documentos_com_problema ?? [];
  const docs = Array.isArray(docsRaw)
    ? docsRaw
        .map(v => {
          if (typeof v === 'number') return v;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        })
        .filter((n): n is number => n != null)
    : [];

  return {
    acao,
    motivo: motivo || '(sem motivo fornecido)',
    camposComProblema: acao === 'solicitar_correcao' ? campos : [],
    documentosComProblema: acao === 'solicitar_correcao' ? docs : [],
  };
}
