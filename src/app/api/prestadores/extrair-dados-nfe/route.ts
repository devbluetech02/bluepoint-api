import { NextRequest, NextResponse } from 'next/server';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Requested-With, X-Request-ID, X-Client-Version, X-Platform',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

/** Resposta do endpoint: apenas numero, dataEmissao, valor, cnpj. */
export type DadosNFe = {
  numero: string | null;
  dataEmissao: string | null;
  valor: number | null;
  cnpj: string | null;
};

function withCors(response: NextResponse): NextResponse {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

/**
 * Preflight CORS: navegador envia OPTIONS antes do POST com Authorization/Content-Type.
 * Responde 200 com headers CORS para o preflight passar e o POST ser enviado.
 */
export function OPTIONS() {
  return withCors(new NextResponse(null, { status: 200 }));
}

function dadosNfeVazios(): DadosNFe {
  return { numero: null, dataEmissao: null, valor: null, cnpj: null };
}

/** Extrai dados de NFe em XML (regex nas tags). Retorna apenas numero, dataEmissao, valor, cnpj. */
function extrairDeXml(buffer: Buffer): DadosNFe {
  const xml = buffer.toString('utf-8');
  let dataEmissao: string | null = null;
  const dhEmiMatch = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/);
  if (dhEmiMatch) dataEmissao = dhEmiMatch[1].trim().split('T')[0];

  let numero: string | null = null;
  const nfeMatch = xml.match(/<nNF>([^<]+)<\/nNF>/);
  if (nfeMatch) numero = nfeMatch[1].trim();

  let valor: number | null = null;
  const vNFMatch = xml.match(/<vNF>([^<]+)<\/vNF>/);
  if (vNFMatch) valor = parseFloat(vNFMatch[1].trim());

  let cnpj: string | null = null;
  const cnpjMatch = xml.match(/<CNPJ>([^<]+)<\/CNPJ>/);
  if (cnpjMatch) cnpj = cnpjMatch[1].trim();

  return { numero, dataEmissao, valor, cnpj };
}

/** Envia PDF para a IA (OpenRouter) e extrai número, data, valor e CNPJ. */
async function extrairDePdfComIA(pdfBase64: string): Promise<{ dados: DadosNFe; aviso?: string; rawResposta?: string }> {
  const baseUrl = (process.env.OPENAI_API_BASE_URL || '').trim().replace(/\/$/, '');
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const model = (process.env.OPENAI_MODEL || 'google/gemini-2.0-flash-001').trim();

  if (!baseUrl || !apiKey) {
    console.warn('[extrair-dados-nfe] OPENAI_API_BASE_URL ou OPENAI_API_KEY não configurados no ambiente.');
    return { dados: dadosNfeVazios(), aviso: 'Configure OPENAI_API_BASE_URL e OPENAI_API_KEY no ambiente onde a API roda e reinicie o serviço.' };
  }

  const prompt = `Você é um extrator de dados de Nota Fiscal Eletrônica (NFe). Este arquivo é um PDF de NFe.
Extraia EXATAMENTE estes 4 campos e responda SOMENTE com um JSON válido, sem texto antes ou depois, sem markdown:
{"numero":"número da nota","dataEmissao":"AAAA-MM-DD","valor":número,"cnpj":"14 dígitos do CNPJ do emitente"}
Regras: numero = string; dataEmissao = só a data em AAAA-MM-DD; valor = número decimal; cnpj = string com 14 dígitos (sem pontuação). Use null se não encontrar.`;

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'file' as const, file: { filename: 'nfe.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` } },
          { type: 'text' as const, text: prompt },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 512,
    response_format: { type: 'json_object' as const },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('[extrair-dados-nfe] OpenRouter API error:', resp.status, errText);
    let detail = errText;
    try {
      const errJson = JSON.parse(errText) as { error?: { message?: string }; message?: string };
      detail = errJson?.error?.message ?? errJson?.message ?? errText;
    } catch {
      // keep
    }
    throw new Error(`OpenRouter: ${resp.status} - ${detail}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    console.error('[extrair-dados-nfe] Resposta inesperada:', JSON.stringify(data).slice(0, 500));
    throw new Error('Resposta da IA sem conteúdo');
  }

  let raw = text.trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) raw = jsonMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[extrair-dados-nfe] JSON inválido da IA:', raw.slice(0, 300));
    throw new Error('Resposta da IA não é JSON válido');
  }

  const getStr = (v: unknown): string | null =>
    v == null ? null : typeof v === 'string' ? v.trim() || null : String(v).trim() || null;
  const getNum = (v: unknown): number | null =>
    v == null ? null : typeof v === 'number' && !Number.isNaN(v) ? v : typeof v === 'string' ? (parseFloat(v) || null) : null;

  let obj: Record<string, unknown>;
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
    obj = parsed[0] as Record<string, unknown>;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const p = parsed as Record<string, unknown>;
    if (p.dados || p.data) {
      const inner = (p.dados ?? p.data) as Record<string, unknown>;
      obj = inner && typeof inner === 'object' ? inner : p;
    } else {
      obj = p;
    }
  } else {
    obj = {};
  }

  const numero = getStr(
    obj.numero ?? obj.numero_nota ?? obj.numeroNFe ?? obj.nNF ?? obj.numero_da_nota ?? (obj as Record<string, unknown>)['Número']
  );
  const dataEmissao = getStr(
    obj.dataEmissao ?? obj.data ?? obj.data_emissao ?? obj.dhEmi ?? obj.data_emissao_nfe ?? (obj as Record<string, unknown>)['Data de Emissão']
  );
  const valor = getNum(
    obj.valor ?? obj.valor_total ?? obj.vNF ?? obj.valorTotal ?? obj.valor_nf ?? (obj as Record<string, unknown>)['Valor']
  );
  let cnpj = getStr(
    obj.cnpj ?? obj.cnpjEmitente ?? obj.CNPJ ?? obj.cnpj_emitente ?? (obj as Record<string, unknown>)['CNPJ']
  );
  const cnpjDigits = cnpj ? cnpj.replace(/\D/g, '') : '';
  const cnpjFinal = cnpjDigits.length === 14 ? cnpjDigits : (cnpjDigits.length > 0 ? cnpjDigits : null);

  const dados: DadosNFe = { numero, dataEmissao, valor, cnpj: cnpjFinal };
  const allNull = !numero && !dataEmissao && !valor && !cnpjFinal;
  if (allNull) {
    console.warn('[extrair-dados-nfe] IA retornou todos null. Resposta:', raw.slice(0, 600));
  }

  return { dados, ...(allNull ? { rawResposta: raw.slice(0, 1200) } : {}) };
}

/**
 * Extrai dados da NFe (arquivo PDF ou XML).
 * Retorna apenas: numero, dataEmissao, valor, cnpj.
 * - XML: extração por regex.
 * - PDF: envio para IA via OpenRouter.
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return withCors(
        NextResponse.json(
          { success: false, error: 'Envie o arquivo da NFe em multipart/form-data (campo arquivo ou file)' },
          { status: 400 }
        )
      );
    }

    const formData = await request.formData();
    const arquivo = (formData.get('arquivo') ?? formData.get('file')) as File | null;

    if (!arquivo || !(arquivo instanceof File) || arquivo.size === 0) {
      return withCors(
        NextResponse.json(
          { success: false, error: 'Nenhum arquivo enviado. Use o campo "arquivo" ou "file".' },
          { status: 400 }
        )
      );
    }

    const nome = arquivo.name?.toLowerCase() ?? '';
    const isXml = nome.endsWith('.xml');
    const isPdf = nome.endsWith('.pdf');

    if (!isXml && !isPdf) {
      return withCors(
        NextResponse.json(
          { success: false, error: 'Formato não suportado. Envie um arquivo .xml ou .pdf da NFe.' },
          { status: 400 }
        )
      );
    }

    const buffer = Buffer.from(await arquivo.arrayBuffer());

    let dados: DadosNFe;

    if (isXml) {
      dados = extrairDeXml(buffer);
    } else {
      const resultado = await extrairDePdfComIA(buffer.toString('base64'));
      dados = resultado.dados;
      if (resultado.aviso) {
        return withCors(
          NextResponse.json({
            success: true,
            data: { numero: dados.numero, dataEmissao: dados.dataEmissao, valor: dados.valor, cnpj: dados.cnpj },
            aviso: resultado.aviso,
          }, { status: 200 })
        );
      }
      if (resultado.rawResposta) {
        return withCors(
          NextResponse.json({
            success: true,
            data: { numero: dados.numero, dataEmissao: dados.dataEmissao, valor: dados.valor, cnpj: dados.cnpj },
            _debug: { rawResposta: resultado.rawResposta },
          }, { status: 200 })
        );
      }
    }

    return withCors(
      NextResponse.json({
        success: true,
        data: {
          numero: dados.numero,
          dataEmissao: dados.dataEmissao,
          valor: dados.valor,
          cnpj: dados.cnpj,
        },
      }, { status: 200 })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isOpenRouter = message.startsWith('OpenRouter:');
    console.error('[extrair-dados-nfe] Erro:', message, error instanceof Error ? error.stack : '');
    return withCors(
      NextResponse.json(
        {
          success: false,
          error: 'Erro ao processar arquivo da NFe',
          ...(isOpenRouter || process.env.NODE_ENV !== 'production' ? { detail: message } : {}),
        },
        { status: 500 }
      )
    );
  }
}
