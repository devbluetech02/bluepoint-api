import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';

const STATUS_VALIDOS = [
  'nao_acessado', 'aguardando_rh', 'correcao_solicitada', 'aso_solicitado',
  'aso_recebido', 'em_teste', 'aso_reprovado', 'assinatura_solicitada',
  'contrato_assinado', 'admitido', 'rejeitado', 'cancelado',
];

const STATUS_ASO = new Set(['aso_solicitado', 'aso_recebido']);

function buildEndereco(row: Record<string, string | null>): string {
  const partes = [
    row.clinica_logradouro,
    row.clinica_numero ? row.clinica_logradouro ? `, ${row.clinica_numero}` : row.clinica_numero : null,
    row.clinica_bairro ? ` — ${row.clinica_bairro}` : null,
    row.clinica_cidade && row.clinica_estado ? `, ${row.clinica_cidade}/${row.clinica_estado}` : (row.clinica_cidade ?? null),
    row.clinica_cep ? `, ${row.clinica_cep}` : null,
  ];
  return partes.filter(Boolean).join('') || '';
}

function buildAso(row: Record<string, unknown>): Record<string, unknown> | null {
  if (!STATUS_ASO.has(row.status as string) || !row.clinica_id) return null;

  const aso: Record<string, unknown> = {
    clinica: row.clinica_nome as string,
    endereco: buildEndereco(row as Record<string, string | null>),
  };

  if (row.data_exame_aso) {
    aso.dataHora = new Date(row.data_exame_aso as string).toISOString();
  }

  if (row.mensagem_aso) aso.observacoes = row.mensagem_aso;

  return aso;
}

/**
 * GET /api/v1/admissao/solicitacoes
 * Lista solicitações de admissão com paginação e filtro por status.
 * Retorna nome, empresa e cargo do usuário provisório vinculado.
 * Quando status é aso_solicitado/aso_recebido, inclui sub-objeto `aso` com dados do exame.
 * Se o token for de usuário provisório, filtra apenas as suas próprias solicitações.
 */
export async function GET(request: NextRequest) {
  return withAdmissao(request, async (req, user) => {
    try {
      const { searchParams } = request.nextUrl;
      const status = searchParams.get('status');
      // statuses=a,b,c filtra por uma fase do funil (vários status agrupados na UI).
      // Convive com `status` por back-compat — se ambos vierem, statuses tem precedência.
      const statusesRaw = searchParams.get('statuses');
      const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
      const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20')));
      const offset = (page - 1) * limit;

      // Filtros divididos em dois grupos pra fluxo de dedup correto:
      //
      //   - dedupConditions  → escopo do provisório + busca por nome/CPF.
      //                        Aplicados DENTRO do CTE, junto com o ROW_NUMBER.
      //                        Estreitam o universo do dedup, mas não escondem
      //                        solicitações mais recentes do mesmo provisório.
      //
      //   - statusCondition  → filtro de fase (status). Aplicado APÓS o dedup,
      //                        no SELECT final. Garante que a "fase" reflete
      //                        a última solicitação real do provisório — não
      //                        uma anterior que casa com o status escolhido.
      //
      // Bug anterior: status entrava no CTE, então a CTE excluía a solicitação
      // mais recente quando ela não casava com o filtro, e o ROW_NUMBER promovia
      // a anterior — mostrando o mesmo provisório em DUAS fases distintas. Ex:
      // "LEONARDO" tinha last=aguardando_rh + anterior=admitido → aparecia em
      // ambos os filtros.
      const dedupConditions: string[] = [];
      const params: unknown[] = [];

      // Usuário provisório só vê as próprias solicitações (escopo, não filtro).
      if (user.tipo === 'provisorio') {
        params.push(user.userId);
        dedupConditions.push(`s.usuario_provisorio_id = $${params.length}`);
      }

      // Busca livre por nome ou CPF — entra no dedup pra alinhar com a UX
      // (provisório que casa com a busca aparece na sua última solicitação).
      const busca = searchParams.get('busca')?.trim();
      if (busca) {
        const buscaConds: string[] = [];
        params.push(`%${busca}%`);
        buscaConds.push(`LOWER(up.nome) LIKE LOWER($${params.length})`);
        const buscaDigits = busca.replace(/\D/g, '');
        if (buscaDigits.length >= 3) {
          params.push(`%${buscaDigits}%`);
          buscaConds.push(
            `REGEXP_REPLACE(COALESCE(up.cpf, ''), '[^0-9]', '', 'g') LIKE $${params.length}`,
          );
        }
        dedupConditions.push(`(${buscaConds.join(' OR ')})`);
      }

      // Filtro de status — aplicado DEPOIS do dedup.
      let statusCondition = '';
      if (statusesRaw) {
        const lista = statusesRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && STATUS_VALIDOS.includes(s));
        if (lista.length === 0) {
          return successResponse({ solicitacoes: [], total: 0, page, limit });
        }
        params.push(lista);
        statusCondition = `AND s.status = ANY($${params.length}::text[])`;
      } else if (status) {
        if (!STATUS_VALIDOS.includes(status)) {
          return successResponse({ solicitacoes: [], total: 0, page, limit });
        }
        params.push(status);
        statusCondition = `AND s.status = $${params.length}`;
      }

      const dedupWhere =
        dedupConditions.length > 0 ? `WHERE ${dedupConditions.join(' AND ')}` : '';

      const latestFilteredCTE = `
        WITH filtradas AS (
          SELECT s.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY COALESCE(s.usuario_provisorio_id::text, s.id::text)
                   ORDER BY s.criado_em DESC
                 ) AS rn
          FROM people.solicitacoes_admissao s
          LEFT JOIN people.usuarios_provisorios up ON up.id = s.usuario_provisorio_id
          ${dedupWhere}
        )
      `;

      const countResult = await query(
        `${latestFilteredCTE}
         SELECT COUNT(*) as total
           FROM filtradas s
          WHERE s.rn = 1
            ${statusCondition}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      params.push(limit, offset);
      const dataResult = await query(
        `${latestFilteredCTE}
         SELECT
           s.id,
           s.formulario_id,
           s.status,
           s.dados,
           s.clinica_id,
           s.data_exame_aso,
           s.mensagem_aso,
           s.aso_solicitado_em,
           s.aso_recebido_em,
           s.assinatura_solicitada_em,
           s.contrato_assinado_em,
           s.criado_em,
           s.atualizado_em,
           up.id             AS usuario_id,
           up.nome           AS usuario_nome,
           up.cpf            AS usuario_cpf,
           up.dias_teste     AS usuario_dias_teste,
           c.id              AS cargo_id,
           c.nome            AS cargo_nome,
           e.id              AS empresa_id,
           e.nome_fantasia   AS empresa_nome,
           cl.nome           AS clinica_nome,
           cl.logradouro     AS clinica_logradouro,
           cl.numero         AS clinica_numero,
           cl.bairro         AS clinica_bairro,
           cl.cidade         AS clinica_cidade,
           cl.estado         AS clinica_estado,
           cl.cep            AS clinica_cep,
           s.documento_assinatura_id
         FROM filtradas s
         LEFT JOIN people.usuarios_provisorios up ON up.id = s.usuario_provisorio_id
         LEFT JOIN people.cargos   c ON c.id = up.cargo_id
         LEFT JOIN people.empresas e ON e.id = up.empresa_id
         LEFT JOIN people.clinicas cl ON cl.id = s.clinica_id
         WHERE s.rn = 1
           ${statusCondition}
         ORDER BY s.criado_em DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      // Busca TODOS os documentos vinculados a cada solicitação
      // (multi-doc: DP pode mandar 2+ contratos). Tabela
      // solicitacoes_admissao_documentos guarda 1 row por envelope SignProof.
      // Map: solicitacaoId → [{docId, titulo, ordem, templateId}]
      const solicitacaoIds = dataResult.rows.map((r) => (r as { id: string }).id);
      interface SolDocRow {
        solicitacao_id: string;
        signproof_doc_id: string;
        template_id: string | null;
        titulo: string | null;
        ordem: number | null;
      }
      const docsBySolicitacao = new Map<string, SolDocRow[]>();
      if (solicitacaoIds.length > 0) {
        const docsRes = await query<SolDocRow>(
          `SELECT solicitacao_id::text  AS solicitacao_id,
                  signproof_doc_id,
                  template_id::text     AS template_id,
                  titulo,
                  ordem
             FROM people.solicitacoes_admissao_documentos
            WHERE solicitacao_id = ANY($1::uuid[])
            ORDER BY ordem ASC NULLS LAST, criado_em ASC`,
          [solicitacaoIds]
        );
        for (const row of docsRes.rows) {
          const list = docsBySolicitacao.get(row.solicitacao_id) ?? [];
          list.push(row);
          docsBySolicitacao.set(row.solicitacao_id, list);
        }
      }

      // Consulta SignProof em paralelo pra cada doc — devolve progresso
      // detalhado (signed_count, signer_count, signers[]) sem signing_link.
      // Mesmo padrão usado em /dia-teste/agendamentos.
      const docIds = Array.from(new Set([
        // Legacy: documento_assinatura_id na linha da solicitação
        ...dataResult.rows
          .map((r) => (r as { documento_assinatura_id: string | null }).documento_assinatura_id)
          .filter((v): v is string => v != null && v !== ''),
        // Multi-doc: todos signproof_doc_id da tabela _documentos
        ...Array.from(docsBySolicitacao.values()).flat().map((d) => d.signproof_doc_id),
      ]));
      interface DocProgresso {
        status: string;
        signedCount: number;
        signerCount: number;
        allSigned: boolean;
        signers: Array<{
          id: string; nome: string; email: string | null; role: string | null;
          signOrder: number | null; status: string; signedAt: string | null;
        }>;
      }
      const docStatusMap = new Map<string, DocProgresso>();
      if (docIds.length > 0) {
        const baseUrl = process.env.SIGNPROOF_API_URL;
        const apiKey = process.env.SIGNPROOF_API_KEY;
        if (baseUrl && apiKey) {
          await Promise.allSettled(
            docIds.map(async (docId) => {
              try {
                const r = await fetch(
                  `${baseUrl}/api/v1/integration/documents/${docId}/status`,
                  { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } },
                );
                if (!r.ok) return;
                const d = (await r.json()) as {
                  status?: string; signer_count?: number; signed_count?: number;
                  all_signed?: boolean;
                  signers?: Array<{
                    id?: string; name?: string; email?: string | null;
                    role?: string | null; sign_order?: number | null;
                    status?: string; signed_at?: string | null;
                  }>;
                };
                docStatusMap.set(docId, {
                  status: d.status ?? 'pending',
                  signedCount: d.signed_count ?? 0,
                  signerCount: d.signer_count ?? 0,
                  allSigned: d.all_signed ?? false,
                  signers: (d.signers ?? []).map((s) => ({
                    id: s.id ?? '',
                    nome: s.name ?? '',
                    email: s.email ?? null,
                    role: s.role ?? null,
                    signOrder: s.sign_order ?? null,
                    status: s.status ?? 'pending',
                    signedAt: s.signed_at ?? null,
                  })),
                });
              } catch (e) {
                console.warn(`[admissao/solicitacoes] falha SignProof doc ${docId}:`, e);
              }
            }),
          );
        }
      }

      const solicitacoes = dataResult.rows.map((row) => {
        const aso = buildAso(row);
        const docId = row.documento_assinatura_id ?? null;
        const progresso = docId ? (docStatusMap.get(docId) ?? null) : null;

        // Multi-doc: lista TODOS documentos vinculados (preferindo a tabela
        // solicitacoes_admissao_documentos que cobre o fluxo de N envelopes).
        // Quando vazia, fallback p/ documento_assinatura_id legado.
        const linkedDocs = docsBySolicitacao.get(row.id) ?? [];
        const documentos = (linkedDocs.length > 0
          ? linkedDocs.map((d) => ({
              docId:      d.signproof_doc_id,
              templateId: d.template_id,
              titulo:     d.titulo,
              ordem:      d.ordem,
              progresso:  docStatusMap.get(d.signproof_doc_id) ?? null,
            }))
          : (docId
              ? [{
                  docId,
                  templateId: null as string | null,
                  titulo:     null as string | null,
                  ordem:      0,
                  progresso,
                }]
              : []));

        // Agrega contagem signed/signer somando todos docs (pra display
        // unificado no chip de status na tabela).
        const aggSignedCount = documentos.reduce(
          (s, d) => s + (d.progresso?.signedCount ?? 0), 0,
        );
        const aggSignerCount = documentos.reduce(
          (s, d) => s + (d.progresso?.signerCount ?? 0), 0,
        );

        return {
          id:           row.id,
          formularioId: row.formulario_id,
          status:       row.status,
          dados:        row.dados,
          diasTeste:    row.usuario_dias_teste ?? null,
          criadoEm:     row.criado_em,
          atualizadoEm: row.atualizado_em,
          asoSolicitadoEm:        row.aso_solicitado_em        ?? null,
          asoRecebidoEm:          row.aso_recebido_em          ?? null,
          assinaturaSolicitadaEm: row.assinatura_solicitada_em ?? null,
          contratoAssinadoEm:     row.contrato_assinado_em     ?? null,
          candidato: row.usuario_id ? {
            id:   row.usuario_id,
            nome: row.usuario_nome,
            cpf:  row.usuario_cpf,
            diasTeste: row.usuario_dias_teste ?? null,
            cargo:   row.cargo_id   ? { id: row.cargo_id,   nome: row.cargo_nome   } : null,
            empresa: row.empresa_id ? { id: row.empresa_id, nome: row.empresa_nome } : null,
          } : null,
          documentoAssinaturaId: docId,
          documentoAssinaturaStatus: progresso?.status ?? null,
          documentoAssinaturaProgresso: progresso,
          // Novos campos: lista completa multi-doc + contagem agregada
          documentos,
          documentosAssinaturaProgresso: {
            signedCount: aggSignedCount,
            signerCount: aggSignerCount,
            allSigned: aggSignerCount > 0 && aggSignedCount >= aggSignerCount,
          },
          ...(aso ? { aso } : {}),
        };
      });

      return successResponse({ solicitacoes, total, page, limit });
    } catch (error) {
      console.error('Erro ao listar solicitações de admissão:', error);
      return serverErrorResponse('Erro ao listar solicitações de admissão');
    }
  });
}
