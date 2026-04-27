import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { openRouterChat, extractJson } from '@/lib/openrouter';
import {
  buildPromptMessages,
  parseDecisao,
  PromptContext,
  AnaliseIaAnterior,
  CampoFormInfo,
  DecisaoIa,
} from '@/lib/admissao-ia-prompt';
import { mapCamposParaApi } from '@/lib/formulario-admissao';
import { enviarPushParaCargoNome } from '@/lib/push-colaborador';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';
import { registrarAuditoria } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/admissao/solicitacoes/:id/analisar-ia
 *
 * Dispara análise da pré-admissão pela IA (OpenRouter). Só faz sentido
 * quando a solicitação está em `aguardando_rh` — outro status retorna 409.
 *
 * Fluxo:
 *   1. Carrega solicitação + campos do formulário + dados preenchidos +
 *      documentos obrigatórios/enviados + histórico de análises IA.
 *   2. Constrói prompt estruturado e chama OpenRouter.
 *   3. Parseia a decisão (JSON).
 *   4. Aplica regra da 2ª correção: se a IA quer flaggar um campo/doc
 *      que já foi flaggado em análise anterior, força `escalar_humano`.
 *   5. Persiste em people.admissao_ia_analises (sempre, mesmo em falha).
 *   6. Executa a ação:
 *        solicitar_correcao → transiciona status + grava pendencias +
 *          dispara push pro candidato (igual endpoint /solicitar-correcao).
 *        ok_para_aso → não muda status; só deixa anotação e notifica admin.
 *        escalar_humano → não muda status; notifica admin com motivo.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (_req, user) => {
    try {
      const { id } = await params;

      // ── 1. Solicitação base ───────────────────────────────────────────
      const solRes = await query<{
        id: string;
        status: string;
        dados: Record<string, unknown> | null;
        formulario_id: string;
        usuario_provisorio_id: number | null;
        onesignal_subscription_id: string | null;
        pendencias_correcao: unknown;
      }>(
        `SELECT id, status, dados, formulario_id, usuario_provisorio_id,
                onesignal_subscription_id, pendencias_correcao
           FROM people.solicitacoes_admissao
          WHERE id = $1`,
        [id],
      );
      if (solRes.rows.length === 0) return notFoundResponse('Solicitação não encontrada');
      const sol = solRes.rows[0];

      if (sol.status !== 'aguardando_rh') {
        return errorResponse(
          `Análise IA só está disponível para solicitações em "aguardando_rh". Status atual: ${sol.status}`,
          409,
        );
      }

      // ── 2. Formulário + docs obrigatórios ─────────────────────────────
      const formRes = await query<{
        campos: unknown;
        documentos_requeridos: unknown;
      }>(
        `SELECT campos, documentos_requeridos
           FROM people.formularios_admissao
          WHERE id = $1`,
        [sol.formulario_id],
      );
      const camposForm = formRes.rows.length > 0
        ? mapCamposParaApi(formRes.rows[0].campos, true)
        : [];
      // documentos_requeridos é JSONB; pode vir no formato antigo (number[])
      // ou no novo (Array<{tipoDocumentoId, obrigatorio, cargosOpcoes}>).
      // Extrai os IDs em ambos os casos pra alimentar a query int[] abaixo.
      const docsReqRaw = formRes.rows[0]?.documentos_requeridos;
      const docsReqIds: number[] = Array.isArray(docsReqRaw)
        ? docsReqRaw
            .map((entry) => {
              if (typeof entry === 'number') return entry;
              if (entry && typeof entry === 'object') {
                const v = (entry as Record<string, unknown>)['tipoDocumentoId'];
                if (typeof v === 'number') return v;
                if (typeof v === 'string') {
                  const n = parseInt(v, 10);
                  return Number.isNaN(n) ? null : n;
                }
              }
              return null;
            })
            .filter((n): n is number => n !== null)
        : [];

      // Resolve nome dos tipos de documento obrigatórios
      const docsObrigatorios: { tipoId: number; tipoNome: string }[] = [];
      if (docsReqIds.length > 0) {
        const tiposRes = await query<{ id: number; nome_exibicao: string }>(
          `SELECT id, nome_exibicao FROM people.tipos_documento_colaborador
            WHERE id = ANY($1::int[])
            ORDER BY id`,
          [docsReqIds],
        );
        for (const r of tiposRes.rows) {
          docsObrigatorios.push({ tipoId: r.id, tipoNome: r.nome_exibicao });
        }
      }

      // ── 3. Docs enviados ──────────────────────────────────────────────
      const docsRes = await query<{
        tipo_documento_id: number;
        tipo_nome: string;
        nome_arquivo: string;
      }>(
        `SELECT d.tipo_documento_id,
                t.nome_exibicao AS tipo_nome,
                d.nome AS nome_arquivo
           FROM people.documentos_admissao d
           JOIN people.tipos_documento_colaborador t ON t.id = d.tipo_documento_id
          WHERE d.solicitacao_id = $1
          ORDER BY d.criado_em ASC`,
        [id],
      );
      const documentosEnviados = docsRes.rows.map((d) => ({
        tipoId: d.tipo_documento_id,
        tipoNome: d.tipo_nome,
        nomeArquivo: d.nome_arquivo,
      }));

      // ── 4. Análises IA anteriores ─────────────────────────────────────
      const analisesRes = await query<{
        disparado_em: Date;
        acao_decidida: string;
        motivo: string | null;
        campos_problema: string[];
        documentos_problema: number[];
      }>(
        `SELECT disparado_em, acao_decidida, motivo,
                campos_problema, documentos_problema
           FROM people.admissao_ia_analises
          WHERE solicitacao_id = $1
          ORDER BY disparado_em DESC
          LIMIT 10`,
        [id],
      );
      // db.ts desliga o type parser de timestamp do pg → disparado_em vem
      // como string. Converte pra Date pra compatibilidade com o consumer
      // (admissao-ia-prompt usa toISOString).
      const analisesAnteriores: AnaliseIaAnterior[] = analisesRes.rows.map((a) => ({
        quando: a.disparado_em instanceof Date
          ? a.disparado_em
          : new Date(a.disparado_em as unknown as string),
        acao: a.acao_decidida,
        motivo: a.motivo,
        camposProblema: Array.isArray(a.campos_problema) ? a.campos_problema : [],
        documentosProblema: Array.isArray(a.documentos_problema) ? a.documentos_problema : [],
      }));

      // ── 5. Candidato (nome/cpf/cargo) ─────────────────────────────────
      let candidatoNome = '';
      let candidatoCpf = '';
      let candidatoCargo = '';
      if (sol.usuario_provisorio_id) {
        const upRes = await query<{
          nome: string;
          cpf: string | null;
          cargo_nome: string | null;
        }>(
          `SELECT up.nome, up.cpf, c.nome AS cargo_nome
             FROM people.usuarios_provisorios up
             LEFT JOIN people.cargos c ON c.id = up.cargo_id
            WHERE up.id = $1`,
          [sol.usuario_provisorio_id],
        );
        if (upRes.rows.length > 0) {
          candidatoNome = upRes.rows[0].nome ?? '';
          candidatoCpf = upRes.rows[0].cpf ?? '';
          candidatoCargo = upRes.rows[0].cargo_nome ?? '';
        }
      }

      // ── 6. Monta contexto e prompt ────────────────────────────────────
      const dados = (sol.dados ?? {}) as Record<string, unknown>;
      const campos: CampoFormInfo[] = camposForm.map((c) => ({
        id: c.id ?? '',
        label: c.label,
        tipo: c.tipo,
        obrigatorio: c.obrigatorio,
        valor: c.id ? (dados[c.id] ?? '').toString() : '',
      }));

      const ctx: PromptContext = {
        candidatoNome,
        candidatoCpf,
        cargo: candidatoCargo,
        campos,
        documentosEnviados,
        documentosObrigatorios: docsObrigatorios,
        analisesAnteriores,
      };

      // ── 7. Chamada à IA ───────────────────────────────────────────────
      const messages = buildPromptMessages(ctx);
      const llmResult = await openRouterChat(messages, {
        temperature: 0.1,
        responseFormatJson: true,
        maxTokens: 800,
      });

      if (!llmResult.ok) {
        await persistirFalha(id, user.userId > 0 ? user.userId : null, llmResult.reason);
        return errorResponse(`Falha ao consultar IA: ${llmResult.reason}`, 502);
      }

      const decisaoRaw = extractJson<unknown>(llmResult.content);
      const decisao = parseDecisao(decisaoRaw);
      if (!decisao) {
        await persistirFalha(
          id,
          user.userId > 0 ? user.userId : null,
          `parse_falhou: ${llmResult.content.slice(0, 200)}`,
        );
        return errorResponse('IA respondeu em formato inválido. Tente novamente.', 502);
      }

      // ── 8. Regra da 2ª correção ───────────────────────────────────────
      // Se a nova decisão é solicitar_correcao e qualquer campo/doc flaggado
      // já foi flaggado numa análise anterior do MESMO tipo, escala pra humano.
      let acaoFinal = decisao.acao;
      let escaladoPorRegra = false;
      let motivoFinal = decisao.motivo;

      if (decisao.acao === 'solicitar_correcao') {
        const flaggadosAntes = new Set<string>();
        const docsFlaggadosAntes = new Set<number>();
        for (const a of analisesAnteriores) {
          if (a.acao !== 'solicitar_correcao') continue;
          a.camposProblema.forEach((c) => flaggadosAntes.add(c));
          a.documentosProblema.forEach((d) => docsFlaggadosAntes.add(d));
        }
        const camposDupl = decisao.camposComProblema.filter((c) => flaggadosAntes.has(c));
        const docsDupl = decisao.documentosComProblema.filter((d) => docsFlaggadosAntes.has(d));
        if (camposDupl.length > 0 || docsDupl.length > 0) {
          acaoFinal = 'escalar_humano';
          escaladoPorRegra = true;
          motivoFinal =
            'IA flaggou problemas já reportados antes (2ª iteração). ' +
            `Campos repetidos: ${camposDupl.join(', ') || '-'}. ` +
            `Documentos repetidos: ${docsDupl.join(', ') || '-'}. ` +
            `Motivo original da IA: ${decisao.motivo}`;
        }
      }

      // ── 9. Persiste análise ───────────────────────────────────────────
      const canceladoPor = user.userId > 0 ? user.userId : null;
      await query(
        `INSERT INTO people.admissao_ia_analises (
           solicitacao_id, disparado_por, modelo,
           acao_decidida, motivo,
           campos_problema, documentos_problema, escalado_por_regra,
           prompt_tokens, completion_tokens, raw_response
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb)`,
        [
          id,
          canceladoPor,
          llmResult.model,
          acaoFinal,
          motivoFinal,
          JSON.stringify(decisao.camposComProblema),
          JSON.stringify(decisao.documentosComProblema),
          escaladoPorRegra,
          llmResult.usage.prompt_tokens ?? null,
          llmResult.usage.completion_tokens ?? null,
          JSON.stringify(llmResult.raw),
        ],
      );

      // ── 10. Executa ação ──────────────────────────────────────────────
      if (acaoFinal === 'solicitar_correcao') {
        await aplicarSolicitacaoCorrecao(
          id,
          sol.status,
          decisao,
          sol.usuario_provisorio_id,
          sol.onesignal_subscription_id,
        );
      } else if (acaoFinal === 'escalar_humano') {
        enviarPushParaCargoNome('Administrador', {
          titulo: 'IA escalou análise para o DP',
          mensagem: motivoFinal.length > 200 ? `${motivoFinal.slice(0, 200)}…` : motivoFinal,
          severidade: 'atencao',
          data: {
            tipo: 'admissao_ia',
            acao: 'escalar_humano',
            solicitacaoId: id,
            escaladoPorRegra,
          },
          url: '/pre-admissao',
        }).catch(console.error);
      } else if (acaoFinal === 'ok_para_aso') {
        enviarPushParaCargoNome('Administrador', {
          titulo: 'IA aprovou candidato para ASO',
          mensagem: `A IA revisou os dados e não encontrou pendências. ${motivoFinal}`,
          severidade: 'info',
          data: {
            tipo: 'admissao_ia',
            acao: 'ok_para_aso',
            solicitacaoId: id,
          },
          url: '/pre-admissao',
        }).catch(console.error);
      }

      // Auditoria (fire-and-forget)
      registrarAuditoria({
        usuarioId: canceladoPor,
        usuarioNome: user.nome,
        usuarioEmail: user.email,
        acao: 'editar',
        modulo: 'admissao',
        descricao: `Análise IA: ${acaoFinal}${escaladoPorRegra ? ' (escalado por regra da 2ª correção)' : ''}`,
        entidadeTipo: 'solicitacao_admissao',
        metadados: {
          solicitacaoId: id,
          acaoOriginal: decisao.acao,
          acaoFinal,
          escaladoPorRegra,
          modelo: llmResult.model,
          tokens: llmResult.usage,
        },
      }).catch(console.error);

      return successResponse({
        acao: acaoFinal,
        motivo: motivoFinal,
        camposComProblema: decisao.camposComProblema,
        documentosComProblema: decisao.documentosComProblema,
        escaladoPorRegra,
        modelo: llmResult.model,
        tokens: llmResult.usage,
      });
    } catch (error) {
      console.error('Erro na análise IA:', error);
      return serverErrorResponse('Erro na análise IA');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────────────────────

async function persistirFalha(
  solicitacaoId: string,
  disparadoPor: number | null,
  erro: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO people.admissao_ia_analises (
         solicitacao_id, disparado_por, modelo, acao_decidida, motivo, erro
       ) VALUES ($1, $2, $3, 'falha', $4, $5)`,
      [solicitacaoId, disparadoPor, process.env.OPENROUTER_MODEL ?? 'desconhecido', erro, erro],
    );
  } catch (e) {
    console.error('[analisar-ia] falha ao persistir registro de falha:', e);
  }
}

/**
 * Aplica a mesma lógica do endpoint /solicitar-correcao: atualiza status pra
 * correcao_solicitada, preserva o status anterior, grava pendencias e
 * dispara push. Mantido inline aqui pra evitar refactor de extrair helper
 * compartilhado — se for reusar, vale extrair.
 */
async function aplicarSolicitacaoCorrecao(
  solicitacaoId: string,
  statusAtual: string,
  decisao: DecisaoIa,
  usuarioProvisorioId: number | null,
  subscriptionId: string | null,
): Promise<void> {
  const pendencias = {
    campos: decisao.camposComProblema,
    documentos: decisao.documentosComProblema,
    observacao: decisao.motivo,
    origem: 'ia' as const,
  };

  await query(
    `UPDATE people.solicitacoes_admissao
        SET status                = 'correcao_solicitada',
            status_antes_correcao = CASE
              WHEN status = 'correcao_solicitada' THEN status_antes_correcao
              ELSE $1
            END,
            pendencias_correcao   = $2::jsonb,
            atualizado_em         = NOW()
      WHERE id = $3`,
    [statusAtual, JSON.stringify(pendencias), solicitacaoId],
  );

  if (usuarioProvisorioId) {
    const mensagem = decisao.motivo
      ? `Corrija os itens indicados e reenvie: ${decisao.motivo}`
      : 'Alguns itens precisam ser corrigidos. Abra o app para revisar.';
    enviarPushParaProvisorio(
      usuarioProvisorioId,
      {
        titulo: 'Correção necessária na pré-admissão',
        mensagem,
        severidade: 'atencao',
        data: {
          acao: 'admissao_status',
          solicitacaoId,
          status: 'correcao_solicitada',
          origem: 'ia',
        },
      },
      subscriptionId,
    ).catch(console.error);
  }
}
