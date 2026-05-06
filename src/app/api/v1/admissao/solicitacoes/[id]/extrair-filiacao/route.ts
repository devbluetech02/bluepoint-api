import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAdmissao } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { openRouterVision, extractJson } from '@/lib/openrouter';

// POST /api/v1/admissao/solicitacoes/:id/extrair-filiacao
//
// IA olha os documentos enviados pelo candidato (CNH e/ou RG) e extrai
// nome do pai e nome da mãe pra preencher o contrato. Best-effort —
// retorna {nomeMae, nomePai, fonte} ou {nomeMae:null, nomePai:null} se
// nao achou. DP confere/edita no modal antes de enviar.

interface FiliacaoExtraida {
  nomeMae: string | null;
  nomePai: string | null;
  fonte: string | null; // doc tipo de onde extraiu (cnh|rg|outros)
  observacao?: string;
}

const TIPOS_DOC_PERMITIDOS = ['cnh', 'rg', 'identidade', 'documento_identificacao'];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmissao(request, async () => {
    try {
      const { id } = await params;

      const docsRes = await query<{
        url: string;
        nome: string;
        codigo: string | null;
        nome_exibicao: string | null;
      }>(
        `SELECT da.url, da.nome,
                t.codigo, t.nome_exibicao
           FROM people.documentos_admissao da
           LEFT JOIN people.tipos_documento_colaborador t ON t.id = da.tipo_documento_id
          WHERE da.solicitacao_id = $1
            AND da.url IS NOT NULL
            AND da.url <> ''
          ORDER BY
            CASE WHEN LOWER(COALESCE(t.codigo,'')) IN ('cnh','rg','identidade','documento_identificacao') THEN 0 ELSE 1 END,
            da.criado_em DESC
          LIMIT 6`,
        [id],
      );

      if (docsRes.rows.length === 0) {
        return notFoundResponse('Nenhum documento enviado pelo candidato pra extrair filiação');
      }

      // Filtra só docs que parecem ser identificação (CNH/RG). Se a
      // classificação tiver falhado, ainda manda todos pra IA — ela
      // ignora docs que nao sao identidade.
      const docsIdentidade = docsRes.rows.filter((d) =>
        TIPOS_DOC_PERMITIDOS.includes((d.codigo ?? '').toLowerCase()),
      );
      const docsParaIA = docsIdentidade.length > 0 ? docsIdentidade : docsRes.rows;

      // Apenas imagens (jpg/png/heic) — PDF nao funciona via vision API.
      // Se um RG/CNH veio como PDF, a IA cai pro fallback "nao encontrei".
      const imagens = docsParaIA
        .filter((d) => /\.(jpe?g|png|heic|webp)(\?|$)/i.test(d.url))
        .map((d) => d.url)
        .slice(0, 3);

      if (imagens.length === 0) {
        return successResponse({
          nomeMae: null,
          nomePai: null,
          fonte: null,
          observacao: 'Documentos do candidato estão em PDF — IA não consegue ler. Preencha manual.',
        } as FiliacaoExtraida);
      }

      const prompt = [
        'Você é um assistente de RH. Recebe uma ou mais imagens de documentos brasileiros (CNH e/ou RG) e deve extrair APENAS os nomes da filiação do titular.',
        '',
        'Regras:',
        '- "nomePai" = nome completo do pai do titular',
        '- "nomeMae" = nome completo da mãe do titular',
        '- Se algum não estiver visível ou legível, retorne null pro campo correspondente',
        '- Não invente. Não complete sobrenomes. Use exatamente o que está escrito',
        '- Em CNH a filiação está no campo "FILIAÇÃO" — primeira linha = pai, segunda = mãe (na maioria dos modelos)',
        '- Em RG a filiação aparece como "FILHO DE ... E DE ..."',
        '',
        'Responda APENAS com um objeto JSON:',
        '{"nomePai": "...", "nomeMae": "...", "fonte": "cnh"|"rg"|"outros"}',
      ].join('\n');

      const r = await openRouterVision(prompt, imagens, {
        responseFormatJson: true,
        maxTokens: 400,
        timeoutMs: 60_000,
      });

      if (!r.ok) {
        console.warn('[extrair-filiacao] IA falhou:', r.reason);
        return errorResponse(`Falha ao consultar IA: ${r.reason}`, 502);
      }

      const parsed = extractJson<{
        nomePai?: string | null;
        nomeMae?: string | null;
        fonte?: string | null;
      }>(r.content);

      if (!parsed) {
        console.warn('[extrair-filiacao] IA retornou conteúdo não-JSON:', r.content.slice(0, 200));
        return successResponse({
          nomeMae: null,
          nomePai: null,
          fonte: null,
          observacao: 'IA não conseguiu interpretar os documentos. Preencha manual.',
        } as FiliacaoExtraida);
      }

      return successResponse({
        nomePai: parsed.nomePai?.trim() || null,
        nomeMae: parsed.nomeMae?.trim() || null,
        fonte: parsed.fonte?.toString().trim() || null,
      } as FiliacaoExtraida);
    } catch (e) {
      console.error('[extrair-filiacao] erro:', e);
      return serverErrorResponse('Erro ao extrair filiação dos documentos');
    }
  });
}
