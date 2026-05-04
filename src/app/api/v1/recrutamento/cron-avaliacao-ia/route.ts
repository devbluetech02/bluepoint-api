import { NextRequest, NextResponse } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { openRouterChat, extractJson } from '@/lib/openrouter';
import { notificarGestoresRecrutamento } from '@/lib/notificar-gestor-recrutamento';
import {
  normalizarNomeRecrutador,
  SQL_NORMALIZE_NOME,
} from '@/lib/normalizar-nome';
import {
  successResponse,
  serverErrorResponse,
  errorResponse,
} from '@/lib/api-response';

// POST /api/v1/recrutamento/cron-avaliacao-ia
//
// Endpoint de cron — varre todos os recrutadores com entrevistas IA
// recentes e dispara avaliação pra quem acumulou >= N entrevistas
// desde a última avaliação. Idempotente quando chamado várias vezes
// no mesmo dia (não vai re-avaliar quem ainda não atingiu o threshold).
//
// Auth: protegido por `Authorization: Bearer ${CRON_SECRET}`.
// EventBridge / scheduler externo aponta pra cá.
//
// Configurações lidas de people.parametros_rh:
//   - avaliacao_ia_ativa (master switch)
//   - entrevistas_para_avaliar_ia (threshold N)
//
// Resposta: { avaliados, ignorados, falhas, detalhes[] }

interface RecrutadorContagem {
  recrutador: string;
  total: number;
}

interface RespostaIA {
  score?: number;
  veredito?: 'bom' | 'regular' | 'ruim';
  feedback_recrutador?: string;
  feedback_gestor?: string;
  pontos_fortes?: string[];
  pontos_fracos?: string[];
}

function checarAuth(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // se não setado, bloqueia (fail-closed)
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!checarAuth(request)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    // ── 1) Lê parâmetros de RH ──
    const paramRes = await query<{
      avaliacao_ia_ativa: boolean;
      entrevistas_para_avaliar_ia: number;
    }>(
      `SELECT avaliacao_ia_ativa, entrevistas_para_avaliar_ia
         FROM people.parametros_rh
        ORDER BY id DESC LIMIT 1`
    );
    const ativo = paramRes.rows[0]?.avaliacao_ia_ativa ?? true;
    const threshold = paramRes.rows[0]?.entrevistas_para_avaliar_ia ?? 5;

    if (!ativo) {
      return successResponse({
        executado: false,
        motivo: 'avaliacao_ia_ativa=false',
        avaliados: 0,
        ignorados: 0,
        falhas: 0,
      });
    }

    // ── 2) Conta entrevistas IA por recrutador (banco recrutamento) ──
    // Aplica normalização (UPPER + accent-strip + trim + collapse-spaces)
    // no banco pra que "JOÃO" e "JOAO" agrupem na mesma linha.
    const contagemRes = await queryRecrutamento<{
      recrutador: string;
      total: string;
    }>(
      `SELECT ${SQL_NORMALIZE_NOME('COALESCE(ea.recrutador, c.responsavel_entrevista)')} AS recrutador,
              COUNT(*)::text AS total
         FROM public.entrevistas_agendadas ea
         LEFT JOIN public.candidatos c ON c.id = ea.id_candidatura
        WHERE ea.analise IS NOT NULL
          AND TRIM(ea.analise) <> ''
          AND COALESCE(ea.recrutador, c.responsavel_entrevista) IS NOT NULL
          AND TRIM(COALESCE(ea.recrutador, c.responsavel_entrevista)) <> ''
        GROUP BY 1
       HAVING COUNT(*) >= $1`,
      [threshold]
    );

    const recrutadores: RecrutadorContagem[] = contagemRes.rows.map((r) => ({
      recrutador: r.recrutador,
      total: parseInt(r.total, 10),
    }));

    if (recrutadores.length === 0) {
      return successResponse({
        executado: true,
        threshold,
        avaliados: 0,
        ignorados: 0,
        falhas: 0,
        detalhes: [],
      });
    }

    // ── 3) Pra cada recrutador, verifica última avaliação e dispara se necessário ──
    let avaliados = 0;
    let ignorados = 0;
    let falhas = 0;
    const detalhes: Array<{
      recrutador: string;
      acao: 'avaliado' | 'ignorado' | 'falha';
      motivo?: string;
      score?: number;
      veredito?: string;
    }> = [];

    for (const { recrutador, total } of recrutadores) {
      // Última avaliação desse recrutador — checa quantas entrevistas
      // novas ele teve desde então (via data_entrevista no DO).
      const ultRes = await query<{
        criado_em: Date;
        entrevistas_avaliadas: number;
      }>(
        `SELECT criado_em, entrevistas_avaliadas
           FROM people.recrutador_avaliacao_ia
          WHERE recrutador_nome = $1
          ORDER BY criado_em DESC
          LIMIT 1`,
        [recrutador]
      );
      const ultimaData = ultRes.rows[0]?.criado_em;

      let novasEntrevistas = total;
      if (ultimaData) {
        const novasRes = await queryRecrutamento<{ qtd: string }>(
          `SELECT COUNT(*)::text AS qtd
             FROM public.entrevistas_agendadas ea
             LEFT JOIN public.candidatos c ON c.id = ea.id_candidatura
            WHERE ea.analise IS NOT NULL
              AND TRIM(ea.analise) <> ''
              AND ${SQL_NORMALIZE_NOME('COALESCE(ea.recrutador, c.responsavel_entrevista)')} = $1
              AND ea.data_entrevista > $2::timestamp`,
          [recrutador, ultimaData]
        );
        novasEntrevistas = parseInt(novasRes.rows[0]?.qtd ?? '0', 10);
      }

      if (novasEntrevistas < threshold) {
        ignorados++;
        detalhes.push({
          recrutador,
          acao: 'ignorado',
          motivo: `apenas ${novasEntrevistas} entrevistas novas (< ${threshold})`,
        });
        continue;
      }

      // ── Dispara avaliação ──
      const r = await avaliarRecrutador(recrutador, threshold);
      if (r.ok) {
        avaliados++;
        detalhes.push({
          recrutador,
          acao: 'avaliado',
          score: r.score,
          veredito: r.veredito,
        });
      } else {
        falhas++;
        detalhes.push({
          recrutador,
          acao: 'falha',
          motivo: r.motivo,
        });
      }
    }

    return successResponse({
      executado: true,
      threshold,
      avaliados,
      ignorados,
      falhas,
      detalhes,
    });
  } catch (error) {
    console.error('[recrutamento/cron-avaliacao-ia] erro:', error);
    return serverErrorResponse('Erro no cron de avaliação IA');
  }
}

async function avaliarRecrutador(
  recrutador: string,
  ultimas: number
): Promise<
  | { ok: true; score: number; veredito: string }
  | { ok: false; motivo: string }
> {
  // Pega últimas N entrevistas com análise IA
  const analiseRes = await queryRecrutamento<{
    nome_candidato: string | null;
    vaga: string | null;
    data_entrevista: Date | null;
    cobertura: string | null;
    total_aspectos: string | null;
    confirmados: string | null;
    parciais: string | null;
    nao_evidenciados: string | null;
    conclusao: string | null;
    swot_entrevistador: string | null;
  }>(
    `SELECT
       c.nome AS nome_candidato,
       c.vaga,
       ea.data_entrevista,
       (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'cobertura_percent') AS cobertura,
       (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'total_aspectos') AS total_aspectos,
       (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'confirmados') AS confirmados,
       (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'parciais') AS parciais,
       (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'nao_evidenciados') AS nao_evidenciados,
       (ea.analise::jsonb ->> 'conclusao') AS conclusao,
       (ea.analise::jsonb -> 'swot_entrevistador')::text AS swot_entrevistador
     FROM public.entrevistas_agendadas ea
     LEFT JOIN public.candidatos c ON c.id = ea.id_candidatura
     WHERE ea.analise IS NOT NULL
       AND TRIM(ea.analise) <> ''
       AND ${SQL_NORMALIZE_NOME('COALESCE(ea.recrutador, c.responsavel_entrevista)')} = $1
     ORDER BY ea.data_entrevista DESC NULLS LAST, ea.id DESC
     LIMIT $2`,
    [recrutador, ultimas]
  );

  const entrevistas = analiseRes.rows;
  if (entrevistas.length === 0) {
    return { ok: false, motivo: 'sem entrevistas com análise' };
  }

  // O driver pg da base de Recrutamento entrega timestamp como string;
  // converte uma vez aqui pra evitar `.toISOString is not a function`.
  const toDate = (v: Date | string | null | undefined): Date | null => {
    if (!v) return null;
    if (v instanceof Date) return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const resumos = entrevistas.map((e, i) => {
    const d = toDate(e.data_entrevista);
    const data = d ? d.toISOString().slice(0, 10) : '?';
    return [
      `[Entrevista ${i + 1}] data=${data} candidato="${e.nome_candidato ?? '?'}" vaga="${e.vaga ?? '?'}"`,
      `  cobertura_percent=${e.cobertura ?? '?'}`,
      `  confirmados=${e.confirmados ?? '?'} parciais=${e.parciais ?? '?'} nao_evidenciados=${e.nao_evidenciados ?? '?'}`,
      `  conclusao=${(e.conclusao ?? '').slice(0, 600)}`,
      `  swot_entrevistador=${(e.swot_entrevistador ?? '').slice(0, 800)}`,
    ].join('\n');
  });

  const dDe = toDate(entrevistas[entrevistas.length - 1].data_entrevista);
  const dAte = toDate(entrevistas[0].data_entrevista);
  const periodoDe = dDe
    ? dDe.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const periodoAte = dAte
    ? dAte.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Última avaliação anterior do mesmo recrutador — usada como contexto
  // pro modelo (continuidade) E pra checar cooldown da notificação ao gestor.
  const anteriorRes = await query<{
    score: number;
    veredito: string;
    feedback_recrutador: string;
    pontos_fortes: unknown;
    pontos_fracos: unknown;
    criado_em: Date;
    notificou_gestor_em: Date | null;
  }>(
    `SELECT score, veredito, feedback_recrutador, pontos_fortes, pontos_fracos,
            criado_em, notificou_gestor_em
       FROM people.recrutador_avaliacao_ia
      WHERE recrutador_nome = $1
      ORDER BY criado_em DESC LIMIT 1`,
    [recrutador]
  );
  const anterior = anteriorRes.rows[0] ?? null;

  const blocoAnterior = anterior
    ? [
        '',
        '── Avaliação ANTERIOR (use como contexto pra medir evolução) ──',
        `data=${new Date(anterior.criado_em).toISOString().slice(0, 10)}`,
        `score=${anterior.score}/100  veredito=${anterior.veredito}`,
        `feedback_dado=${anterior.feedback_recrutador}`,
        `pontos_fortes=${JSON.stringify(Array.isArray(anterior.pontos_fortes) ? anterior.pontos_fortes : [])}`,
        `pontos_fracos=${JSON.stringify(Array.isArray(anterior.pontos_fracos) ? anterior.pontos_fracos : [])}`,
        'Compare com as entrevistas atuais. Mencione no feedback se o recrutador melhorou ou piorou nos pontos_fracos anteriores.',
      ].join('\n')
    : '';

  const systemPrompt = `Você é um avaliador sênior de recrutadores corporativos. Analise as últimas entrevistas conduzidas e gere diagnóstico curto e acionável. Quando houver "Avaliação ANTERIOR" no contexto, faça uma comparação explícita — o recrutador já recebeu aquele feedback antes.

Critérios:
- Profundidade das perguntas (foi além do roteiro? sondou inconsistências?)
- Cobertura (cobertura_percent e nao_evidenciados são bons indicadores)
- Qualidade da condução (SWOT entrevistador)
- Consistência entre entrevistas
- Evolução em relação ao feedback anterior (se houver)

Responda APENAS com JSON válido:
{
  "score": <int 0-100>,
  "veredito": "bom" | "regular" | "ruim",
  "feedback_recrutador": "<2-4 frases. bom: elogie pontos concretos e diga que o gestor será informado. regular: aponte 1-2 ajustes. ruim: aponte inconsistências e avise que se não melhorar o gestor será contatado. Se houve avaliação anterior, faça referência explícita à evolução.>",
  "feedback_gestor": "<resumo executivo 2-3 frases. NULL se bom.>",
  "pontos_fortes": ["...", "..."],
  "pontos_fracos": ["...", "..."]
}

Thresholds: score >= 80: bom. 60 <= score < 80: regular. score < 60: ruim`;

  const userPrompt = [
    `Recrutador: ${recrutador}`,
    `Período: ${periodoDe} → ${periodoAte}`,
    `Entrevistas analisadas: ${entrevistas.length}`,
    '',
    'Resumo de cada entrevista:',
    ...resumos,
    blocoAnterior,
  ].join('\n');

  const r = await openRouterChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.3,
      maxTokens: 1500,
      responseFormatJson: true,
      timeoutMs: 90_000,
    }
  );

  if (!r.ok) {
    return { ok: false, motivo: `IA: ${r.reason}` };
  }

  const parsed = extractJson<RespostaIA>(r.content);
  if (!parsed) {
    return { ok: false, motivo: 'IA: JSON inválido' };
  }

  const score = Math.max(0, Math.min(100, parsed.score ?? 0));
  const veredito =
    parsed.veredito === 'bom' ||
    parsed.veredito === 'regular' ||
    parsed.veredito === 'ruim'
      ? parsed.veredito
      : score >= 80
        ? 'bom'
        : score >= 60
          ? 'regular'
          : 'ruim';
  const feedbackRecrutador = (parsed.feedback_recrutador ?? '').trim();
  if (!feedbackRecrutador) {
    return { ok: false, motivo: 'IA: feedback vazio' };
  }
  const feedbackGestor = (parsed.feedback_gestor ?? '').trim() || null;
  const pontosFortes = Array.isArray(parsed.pontos_fortes)
    ? parsed.pontos_fortes.slice(0, 8)
    : [];
  const pontosFracos = Array.isArray(parsed.pontos_fracos)
    ? parsed.pontos_fracos.slice(0, 8)
    : [];

  // Notifica gestor se anterior também foi 'ruim' E ainda não havia
  // notificado (cooldown — evita spam em sequência longa de 'ruim').
  // Reutiliza `anterior` resolvido lá em cima, evita 2º round-trip.
  let notificarGestor: Date | null = null;
  if (
    veredito === 'ruim' &&
    anterior?.veredito === 'ruim' &&
    anterior.notificou_gestor_em == null
  ) {
    notificarGestor = new Date();
  }

  const insertRes = await query<{ id: string }>(
    `INSERT INTO people.recrutador_avaliacao_ia (
       recrutador_nome, periodo_de, periodo_ate, entrevistas_avaliadas,
       score, veredito, feedback_recrutador, feedback_gestor,
       pontos_fortes, pontos_fracos, modelo_ia, notificou_gestor_em
     ) VALUES (
       $1, $2::date, $3::date, $4, $5, $6, $7, $8,
       $9::jsonb, $10::jsonb, $11, $12
     )
     RETURNING id::text`,
    [
      recrutador,
      periodoDe,
      periodoAte,
      entrevistas.length,
      score,
      veredito,
      feedbackRecrutador,
      feedbackGestor,
      JSON.stringify(pontosFortes),
      JSON.stringify(pontosFracos),
      r.model,
      notificarGestor,
    ]
  );

  if (notificarGestor != null) {
    await notificarGestoresRecrutamento({
      recrutador,
      score,
      feedbackGestor,
      avaliacaoId: insertRes.rows[0].id,
    });
  }

  // `errorResponse` é usado em outras rotas — mantemos a importação consistente.
  void errorResponse;

  return { ok: true, score, veredito };
}
