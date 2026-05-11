import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { cacheAside, CACHE_TTL } from '@/lib/cache';
import {
  lerInsightsCacheado,
  dispararGeracaoEmBackground,
} from '@/lib/recrutador-insights';

// GET /api/v1/recrutamento/relatorio/dashboard
//
// Dashboard novo (sem filtro de periodo — mostra 3 janelas fixas
// hoje/7d/30d lado a lado por recrutador).
//
// Query params (todos opcionais):
//  - recrutador (string)      filtra por recrutador
//  - vaga       (string)      filtra por vaga (ILIKE)
//  - departamentoId (int)     filtra por departamento (resolvido via
//                             JOIN public.vagas → opcoes; aplica em
//                             entrevista WHERE vaga = ANY(vagas_dept))
//  - duracaoMinSeg (int)      override do parametro global

// Feriados nacionais brasileiros (UTC ISO yyyy-mm-dd). Cobre 2024-2028.
// Inclui dias movidos pela Páscoa (carnaval seg+ter, sexta santa, corpus).
const FERIADOS_NACIONAIS = new Set<string>([
  // 2024
  '2024-01-01','2024-02-12','2024-02-13','2024-03-29','2024-04-21',
  '2024-05-01','2024-05-30','2024-09-07','2024-10-12','2024-11-02',
  '2024-11-15','2024-11-20','2024-12-25',
  // 2025
  '2025-01-01','2025-03-03','2025-03-04','2025-04-18','2025-04-21',
  '2025-05-01','2025-06-19','2025-09-07','2025-10-12','2025-11-02',
  '2025-11-15','2025-11-20','2025-12-25',
  // 2026
  '2026-01-01','2026-02-16','2026-02-17','2026-04-03','2026-04-21',
  '2026-05-01','2026-06-04','2026-09-07','2026-10-12','2026-11-02',
  '2026-11-15','2026-11-20','2026-12-25',
  // 2027
  '2027-01-01','2027-02-08','2027-02-09','2027-03-26','2027-04-21',
  '2027-05-01','2027-05-27','2027-09-07','2027-10-12','2027-11-02',
  '2027-11-15','2027-11-20','2027-12-25',
  // 2028
  '2028-01-01','2028-02-28','2028-02-29','2028-04-14','2028-04-21',
  '2028-05-01','2028-06-15','2028-09-07','2028-10-12','2028-11-02',
  '2028-11-15','2028-11-20','2028-12-25',
]);

function isBusinessDay(dt: Date): boolean {
  const dow = dt.getDay(); // 0=dom, 6=sab
  if (dow === 0 || dow === 6) return false;
  const iso = dt.toISOString().slice(0, 10);
  return !FERIADOS_NACIONAIS.has(iso);
}

function previousBusinessDay(from: Date): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  do {
    d.setDate(d.getDate() - 1);
  } while (!isBusinessDay(d));
  return d;
}

function countBusinessDays(startIncl: Date, endIncl: Date): number {
  let n = 0;
  const cur = new Date(startIncl);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(endIncl);
  end.setHours(0, 0, 0, 0);
  while (cur.getTime() <= end.getTime()) {
    if (isBusinessDay(cur)) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

interface LinhaEntrevista {
  id: number;
  recrutador: string | null;
  vaga: string | null;
  telefone: string | null;
  data_entrevista: Date;
  duracao_seg: number | null;
  aderencia_ia_pct: string | null;
  video_created_at: Date | null;
}

interface AccPeriodo {
  total: number;
  somaDuracao: number;
  comDuracao: number;
  validas: number;
  somaAderencia: number;
  comAderencia: number;
  diasUnicos: Set<string>;
  // Pares (data atual, data anterior) pra calcular gap entre entrevistas
  datasOrdenadas: number[]; // timestamps
}

function novoAcc(): AccPeriodo {
  return {
    total: 0,
    somaDuracao: 0,
    comDuracao: 0,
    validas: 0,
    somaAderencia: 0,
    comAderencia: 0,
    diasUnicos: new Set(),
    datasOrdenadas: [],
  };
}

function consolidar(
  acc: AccPeriodo,
  duracaoMinSeg: number,
  diasUteisPeriodo: number,
) {
  const mediaDuracaoSeg =
    acc.comDuracao > 0 ? Math.round(acc.somaDuracao / acc.comDuracao) : 0;
  const taxaValidas = acc.comDuracao > 0 ? acc.validas / acc.comDuracao : 0;
  const dias = acc.diasUnicos.size || 0;
  // mediaPorDia divide pelo total de dias úteis no período (seg-sex sem
  // feriados nacionais). Entrevistas em fds/feriado são filtradas antes.
  const mediaPorDia = diasUteisPeriodo > 0 ? acc.total / diasUteisPeriodo : 0;
  const mediaAderencia =
    acc.comAderencia > 0 ? acc.somaAderencia / acc.comAderencia : null;
  // Tempo entre entrevistas: média dos gaps entre datas ordenadas (mesmo dia ou cross-dia).
  let mediaGapSeg: number | null = null;
  if (acc.datasOrdenadas.length >= 2) {
    const ord = [...acc.datasOrdenadas].sort((a, b) => a - b);
    let soma = 0;
    let n = 0;
    for (let i = 1; i < ord.length; i++) {
      const gapMs = ord[i] - ord[i - 1];
      // Considera só gaps razoáveis (até 24h) — entre dias separados
      // o gap não faz sentido como "tempo entre entrevistas".
      if (gapMs > 0 && gapMs <= 24 * 60 * 60 * 1000) {
        soma += gapMs;
        n++;
      }
    }
    if (n > 0) mediaGapSeg = Math.round(soma / n / 1000);
  }
  return {
    total: acc.total,
    diasComEntrevista: dias,
    mediaPorDia: Math.round(mediaPorDia * 10) / 10,
    mediaDuracaoSeg,
    mediaGapSeg,
    validas: acc.validas,
    taxaValidasPct: Math.round(taxaValidas * 1000) / 10,
    mediaAderenciaPct: mediaAderencia != null ? Math.round(mediaAderencia * 10) / 10 : null,
    duracaoAlvoSeg: duracaoMinSeg * 1.5,
  };
}

interface PeriodoConsolidado {
  total: number;
  diasComEntrevista: number;
  mediaPorDia: number;
  mediaDuracaoSeg: number;
  mediaGapSeg: number | null;
  validas: number;
  taxaValidasPct: number;
  mediaAderenciaPct: number | null;
  duracaoAlvoSeg: number;
}

function gerarInsights(
  hoje: PeriodoConsolidado,
  sete: PeriodoConsolidado,
  trinta: PeriodoConsolidado,
  duracaoMinSeg: number,
  mediaEquipe: PeriodoConsolidado,
): string[] {
  const out: string[] = [];

  // Volume hoje vs media 7d
  if (hoje.total === 0 && sete.mediaPorDia > 0.5) {
    out.push(`Sem entrevistas hoje. Média recente é ${sete.mediaPorDia.toFixed(1)}/dia.`);
  } else if (hoje.total > 0 && sete.mediaPorDia > 0 && hoje.total < sete.mediaPorDia * 0.5) {
    out.push(`Volume hoje (${hoje.total}) bem abaixo da média (${sete.mediaPorDia.toFixed(1)}/dia).`);
  }

  // Duração 30d vs alvo
  if (trinta.mediaDuracaoSeg > 0) {
    const alvo = duracaoMinSeg * 1.5;
    if (trinta.mediaDuracaoSeg < duracaoMinSeg) {
      out.push(
        `Duração média (${Math.round(trinta.mediaDuracaoSeg / 60)}min) abaixo do mínimo (${Math.round(duracaoMinSeg / 60)}min). Aprofundar perguntas.`,
      );
    } else if (trinta.mediaDuracaoSeg < alvo * 0.7) {
      out.push(
        `Duração média curta (${Math.round(trinta.mediaDuracaoSeg / 60)}min). Alvo ~${Math.round(alvo / 60)}min.`,
      );
    } else if (trinta.mediaDuracaoSeg > alvo * 1.5) {
      out.push(
        `Entrevistas longas demais (${Math.round(trinta.mediaDuracaoSeg / 60)}min). Considerar focar nos pontos-chave.`,
      );
    }
  }

  // Taxa de válidas
  if (trinta.taxaValidasPct < 60 && trinta.total >= 5) {
    out.push(
      `Apenas ${trinta.taxaValidasPct.toFixed(0)}% das entrevistas atingem duração mínima. Evitar conversas curtas demais.`,
    );
  }

  // Aderência IA
  if (trinta.mediaAderenciaPct != null) {
    if (trinta.mediaAderenciaPct < 50) {
      out.push(
        `Aderência ao roteiro IA está em ${trinta.mediaAderenciaPct.toFixed(0)}%. Cobrir mais tópicos sugeridos.`,
      );
    } else if (
      mediaEquipe.mediaAderenciaPct != null &&
      trinta.mediaAderenciaPct < mediaEquipe.mediaAderenciaPct - 15
    ) {
      out.push(
        `Aderência (${trinta.mediaAderenciaPct.toFixed(0)}%) está abaixo da média da equipe (${mediaEquipe.mediaAderenciaPct.toFixed(0)}%).`,
      );
    }
  } else if (trinta.total >= 3) {
    out.push('Sem entrevistas avaliadas pela IA — verificar se transcrições estão sendo geradas.');
  }

  // Gap entre entrevistas (se aplicável)
  if (trinta.mediaGapSeg != null && trinta.mediaGapSeg < 30 * 60 && trinta.total >= 5) {
    out.push(
      `Intervalo médio entre entrevistas é só ${Math.round(trinta.mediaGapSeg / 60)}min — pode estar sem tempo de preparo entre uma e outra.`,
    );
  }

  // Volume comparado à equipe
  if (mediaEquipe.total > 0 && trinta.total > 0 && trinta.total > mediaEquipe.total * 1.3) {
    out.push(`Volume acima da média da equipe — destaque positivo.`);
  } else if (mediaEquipe.total > 5 && trinta.total < mediaEquipe.total * 0.5) {
    out.push(`Volume abaixo da média da equipe — verificar agenda/disponibilidade.`);
  }

  if (out.length === 0) {
    out.push('Métricas dentro do esperado.');
  }
  return out;
}

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const recrutadorFiltro = searchParams.get('recrutador')?.trim() || null;
      const vagaFiltro = searchParams.get('vaga')?.trim() || null;
      const departamentoIdRaw = searchParams.get('departamentoId');
      const departamentoId =
        departamentoIdRaw && /^\d+$/.test(departamentoIdRaw)
          ? parseInt(departamentoIdRaw, 10)
          : null;
      const duracaoMinSegOverride = searchParams.get('duracaoMinSeg');
      // Filtros de custo (R$) — aplicam aos KPIs de "dias de teste".
      const custoMinRaw = searchParams.get('custoMin');
      const custoMaxRaw = searchParams.get('custoMax');
      const custoMin =
        custoMinRaw && /^-?\d+(\.\d+)?$/.test(custoMinRaw)
          ? parseFloat(custoMinRaw)
          : null;
      const custoMax =
        custoMaxRaw && /^-?\d+(\.\d+)?$/.test(custoMaxRaw)
          ? parseFloat(custoMaxRaw)
          : null;

      // 1. Parametro global
      const paramRes = await query<{ duracao_minima_entrevista_minutos: number }>(
        `SELECT duracao_minima_entrevista_minutos FROM people.parametros_rh LIMIT 1`,
      );
      const duracaoMinMin =
        paramRes.rows[0]?.duracao_minima_entrevista_minutos ?? 5;
      const duracaoMinSeg = duracaoMinSegOverride
        ? Math.max(0, parseInt(duracaoMinSegOverride, 10))
        : duracaoMinMin * 60;

      // Cache de resposta inteira por combinacao de filtros — 60s.
      // Dashboard nao e tempo-real (entrevistas chegam em rajada e precisam
      // recarga manual pra ver mudancas mesmo). Multiplos gestores na
      // mesma view (sem filtro) compartilham cache; cada filtro distinto
      // gera sua propria chave.
      const cacheKey = `recrutamento:relatorio:dashboard:v11:${[
        recrutadorFiltro ?? '*',
        vagaFiltro ?? '*',
        departamentoId ?? '*',
        duracaoMinSeg,
        custoMin ?? '*',
        custoMax ?? '*',
      ].join('|')}`;

      const dashboard = await cacheAside(cacheKey, async () => {
      // 2. Filtro departamento → lista de vagas
      let vagasDoDept: string[] | null = null;
      if (departamentoId != null) {
        const vRes = await queryRecrutamento<{ nome_vaga: string }>(
          `SELECT DISTINCT nome_vaga FROM public.vagas WHERE departamento_id = $1`,
          [departamentoId],
        );
        vagasDoDept = vRes.rows.map((r) => r.nome_vaga.trim()).filter(Boolean);
        if (vagasDoDept.length === 0) vagasDoDept = ['__NENHUMA__'];
      }

      // 2b. Carrega recrutadores ATIVOS do People (cargo recrutador).
      // Filtro DUPLO obrigatorio: status='ativo' AND cargo recrutador.
      // Match com texto livre de entrevistas_agendadas.recrutador:
      //  - 1o tenta nome completo normalizado (lower + sem acento)
      //  - fallback: primeiro nome SE for unico entre recrutadores ativos
      //    (evita ambiguidade — "Joao" matchando 2 Joao recrutadores)
      const recrutadoresAtivosRes = await query<{ nome: string }>(
        `SELECT c.nome
           FROM people.colaboradores c
           JOIN people.cargos cg ON cg.id = c.cargo_id
          WHERE c.status = 'ativo'
            AND cg.nome ILIKE '%recrut%'`,
      );
      const stripAcc = (s: string) =>
        s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
      const firstName = (s: string) => {
        const parts = stripAcc(s).split(/\s+/).filter(Boolean);
        return parts.length > 0 ? parts[0] : '';
      };
      const fullNamesAtivos = new Set<string>();
      const firstNameCount = new Map<string, number>();
      for (const r of recrutadoresAtivosRes.rows) {
        const full = stripAcc(r.nome ?? '');
        if (!full) continue;
        fullNamesAtivos.add(full);
        const fn = firstName(r.nome ?? '');
        firstNameCount.set(fn, (firstNameCount.get(fn) ?? 0) + 1);
      }
      const recrutadorAtivo = (nome: string): boolean => {
        const full = stripAcc(nome);
        if (fullNamesAtivos.has(full)) return true;
        const fn = firstName(nome);
        if (!fn) return false;
        // Primeiro nome unico → match seguro. Ambiguo → recusa.
        return firstNameCount.get(fn) === 1;
      };

      // 3. Sempre carrega 60d (engloba 30d + 30d anterior pra comparativo).
      // Filtra na memoria nos buckets hoje/ontem/sete/seteAnt/trinta/trintaAnt.
      const sessenta = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      sessenta.setHours(0, 0, 0, 0);
      const trintaInicio = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      trintaInicio.setHours(0, 0, 0, 0);

      const params: unknown[] = [sessenta.toISOString()];
      let where = `data_entrevista >= $1`;
      if (recrutadorFiltro) {
        params.push(recrutadorFiltro);
        where += ` AND recrutador = $${params.length}`;
      }
      if (vagaFiltro) {
        params.push(`%${vagaFiltro}%`);
        where += ` AND vaga ILIKE $${params.length}`;
      }
      if (vagasDoDept) {
        params.push(vagasDoDept);
        where += ` AND vaga = ANY($${params.length}::text[])`;
      }

      const linhas = await queryRecrutamento<LinhaEntrevista>(
        `SELECT id, recrutador, vaga, telefone, data_entrevista, duracao_seg,
                aderencia_ia_pct, video_created_at
           FROM public.entrevistas_agendadas
          WHERE ${where}`,
        params,
      );

      const hojeIni = new Date();
      hojeIni.setHours(0, 0, 0, 0);
      // Ultimo dia util (anterior a hoje). Comparativo de "hoje" usa
      // este dia em vez de ontem cronologico — pula fds/feriados.
      const uduIni = previousBusinessDay(hojeIni);
      const uduFim = new Date(uduIni.getTime() + 24 * 60 * 60 * 1000);
      const uduAntIni = previousBusinessDay(uduIni);
      const uduAntFim = new Date(uduAntIni.getTime() + 24 * 60 * 60 * 1000);
      const seteIni = new Date(hojeIni.getTime() - 7 * 24 * 60 * 60 * 1000);
      const seteAntIni = new Date(hojeIni.getTime() - 14 * 24 * 60 * 60 * 1000);
      const quinzeIni = new Date(hojeIni.getTime() - 15 * 24 * 60 * 60 * 1000);
      const quinzeAntIni = new Date(hojeIni.getTime() - 30 * 24 * 60 * 60 * 1000);

      // 4. Agrega por recrutador × periodo (3 janelas).
      // No nivel equipe agrega 5 janelas atuais (hoje / ultimo dia util /
      // 7d / 15d / 30d) + suas janelas anteriores pra variacao percentual.
      type ChavePer = 'hoje' | 'sete' | 'trinta';
      type ChavePerEquipe =
        | 'hoje'
        | 'udu'
        | 'uduAnt'
        | 'sete'
        | 'seteAnt'
        | 'quinze'
        | 'quinzeAnt'
        | 'trinta'
        | 'trintaAnt';
      const accs = new Map<string, Record<ChavePer, AccPeriodo>>();
      const accsEquipe: Record<ChavePerEquipe, AccPeriodo> = {
        hoje: novoAcc(),
        udu: novoAcc(),
        uduAnt: novoAcc(),
        sete: novoAcc(),
        seteAnt: novoAcc(),
        quinze: novoAcc(),
        quinzeAnt: novoAcc(),
        trinta: novoAcc(),
        trintaAnt: novoAcc(),
      };

      for (const r of linhas.rows) {
        const k = (r.recrutador ?? 'sem_recrutador').trim() || 'sem_recrutador';
        // Filtro 1: ignora entrevistas de recrutadores sem usuario ativo
        // cargo recrutador no People.
        if (!recrutadorAtivo(k)) continue;
        const dt = new Date(r.data_entrevista);
        // Filtro 2: dashboard contabiliza só dias úteis (seg-sex, sem
        // feriados nacionais). Entrevistas em fds/feriado ficam de fora
        // de todos os KPIs, séries, distribuição e nota dos recrutadores.
        if (!isBusinessDay(dt)) continue;
        const dia = dt.toISOString().slice(0, 10);

        let bucket = accs.get(k);
        if (!bucket) {
          bucket = { hoje: novoAcc(), sete: novoAcc(), trinta: novoAcc() };
          accs.set(k, bucket);
        }

        const aderencia =
          r.aderencia_ia_pct != null ? Number(r.aderencia_ia_pct) : null;

        const aplicarAcc = (a: AccPeriodo) => {
          a.total++;
          a.diasUnicos.add(dia);
          a.datasOrdenadas.push(dt.getTime());
          if (r.duracao_seg != null) {
            a.somaDuracao += r.duracao_seg;
            a.comDuracao++;
            if (r.duracao_seg >= duracaoMinSeg) a.validas++;
          }
          if (aderencia != null && Number.isFinite(aderencia)) {
            a.somaAderencia += aderencia;
            a.comAderencia++;
          }
        };

        // Recrutador: 3 janelas atuais (hoje / 7d / 30d)
        const inTrinta = dt >= trintaInicio;
        const inSete = dt >= seteIni;
        const inHoje = dt >= hojeIni;
        if (inTrinta) aplicarAcc(bucket.trinta);
        if (inSete) aplicarAcc(bucket.sete);
        if (inHoje) aplicarAcc(bucket.hoje);

        // Equipe: 5 janelas atuais + suas anteriores pra variacao percentual.
        if (inTrinta) aplicarAcc(accsEquipe.trinta);
        else aplicarAcc(accsEquipe.trintaAnt);
        if (dt >= quinzeIni) aplicarAcc(accsEquipe.quinze);
        else if (dt >= quinzeAntIni) aplicarAcc(accsEquipe.quinzeAnt);
        if (inSete) aplicarAcc(accsEquipe.sete);
        else if (dt >= seteAntIni) aplicarAcc(accsEquipe.seteAnt);
        if (dt >= uduIni && dt < uduFim) aplicarAcc(accsEquipe.udu);
        else if (dt >= uduAntIni && dt < uduAntFim) aplicarAcc(accsEquipe.uduAnt);
        if (inHoje) aplicarAcc(accsEquipe.hoje);
      }

      // Dias úteis em cada janela — denominador do mediaPorDia.
      // hoje/udu/uduAnt = sempre 1 (udu/uduAnt sao dias uteis por definicao;
      // hoje pode ser 0 se for fds/feriado).
      const bdHoje = isBusinessDay(hojeIni) ? 1 : 0;
      const bdUdu = 1;
      const bdUduAnt = 1;
      const bdSete = countBusinessDays(seteIni, hojeIni);
      const seteAntFim = new Date(seteIni.getTime() - 24 * 60 * 60 * 1000);
      const bdSeteAnt = countBusinessDays(seteAntIni, seteAntFim);
      const bdQuinze = countBusinessDays(quinzeIni, hojeIni);
      const quinzeAntFim = new Date(quinzeIni.getTime() - 24 * 60 * 60 * 1000);
      const bdQuinzeAnt = countBusinessDays(quinzeAntIni, quinzeAntFim);
      const bdTrinta = countBusinessDays(trintaInicio, hojeIni);
      const trintaAntFim = new Date(trintaInicio.getTime() - 24 * 60 * 60 * 1000);
      const bdTrintaAnt = countBusinessDays(sessenta, trintaAntFim);

      // ───────────────────────────────────────────────────────────────
      // Tempo ocioso entre entrevistas (Drive video_created_at)
      // ───────────────────────────────────────────────────────────────
      // Pra cada recrutador, ordena entrevistas com video_created_at
      // valido + duracao_seg no periodo e calcula gap entre o fim do
      // video anterior (video_created_at) e o inicio real do proximo
      // (video_created_at - duracao_seg).
      //
      // Descarta gaps negativos (overlap defeito) e gaps > 4h (almoco/
      // fim-de-expediente). Aplica margem de UPLOAD_LAG_SEG (20min) em
      // cada gap antes de acumular: vídeos sobem pro Drive de forma
      // assíncrona com lag variável de até ~20min, então parte do gap
      // bruto é só atraso de upload, não ociosidade real. gapAjustado
      // = max(0, gapBruto - 20min). Floor em 0 mantém estimativa
      // conservadora.
      const MAX_GAP_OCIO_SEG = 4 * 3600;
      const UPLOAD_LAG_SEG = 20 * 60;

      const entriesPorRec = new Map<string, LinhaEntrevista[]>();
      for (const r of linhas.rows) {
        const k =
          (r.recrutador ?? 'sem_recrutador').trim() || 'sem_recrutador';
        if (!recrutadorAtivo(k)) continue;
        const dt = new Date(r.data_entrevista);
        if (!isBusinessDay(dt)) continue;
        const arr = entriesPorRec.get(k) ?? [];
        arr.push(r);
        entriesPorRec.set(k, arr);
      }

      // Calcula tempo ocioso médio de um conjunto de entradas (já
      // filtrado pra janela do periodo). Retorna null se nao houver
      // pelo menos 2 entradas com video_created_at + duracao_seg.
      function calcOcioMedioSeg(entries: LinhaEntrevista[]): number | null {
        const validos = entries
          .filter((e) => e.video_created_at != null && e.duracao_seg != null)
          .map((e) => ({
            videoEnd: new Date(e.video_created_at!).getTime(),
            duracaoMs: (e.duracao_seg ?? 0) * 1000,
          }))
          .sort((a, b) => a.videoEnd - b.videoEnd);
        if (validos.length < 2) return null;
        let soma = 0;
        let n = 0;
        for (let i = 1; i < validos.length; i++) {
          const prevEnd = validos[i - 1].videoEnd;
          const nextStart = validos[i].videoEnd - validos[i].duracaoMs;
          const gapBrutoMs = nextStart - prevEnd;
          if (gapBrutoMs > 0 && gapBrutoMs <= MAX_GAP_OCIO_SEG * 1000) {
            // Subtrai lag de upload (até ~20min) — parte do gap é
            // só atraso pra subir o video, nao ociosidade real.
            const gapAjustadoMs = Math.max(
              0,
              gapBrutoMs - UPLOAD_LAG_SEG * 1000,
            );
            soma += gapAjustadoMs;
            n++;
          }
        }
        return n > 0 ? Math.round(soma / n / 1000) : null;
      }

      function entriesNaJanela(
        all: LinhaEntrevista[],
        janelaIni: Date,
      ): LinhaEntrevista[] {
        return all.filter((e) => new Date(e.data_entrevista) >= janelaIni);
      }

      // Equipe: agrega todas as entrevistas de todos recrutadores
      // (mesma lógica de janela) e calcula. Por-recrutador: idem na
      // mesma lista do recrutador.
      const todasEntries = Array.from(entriesPorRec.values()).flat();
      const ocioEquipeHoje = calcOcioMedioSeg(
        entriesNaJanela(todasEntries, hojeIni),
      );
      const ocioEquipeSete = calcOcioMedioSeg(
        entriesNaJanela(todasEntries, seteIni),
      );
      const ocioEquipeTrinta = calcOcioMedioSeg(
        entriesNaJanela(todasEntries, trintaInicio),
      );
      const ocioEquipeQuinze = calcOcioMedioSeg(
        entriesNaJanela(todasEntries, quinzeIni),
      );

      const equipeHoje = consolidar(accsEquipe.hoje, duracaoMinSeg, bdHoje);
      const equipeUdu = consolidar(accsEquipe.udu, duracaoMinSeg, bdUdu);
      const equipeUduAnt = consolidar(accsEquipe.uduAnt, duracaoMinSeg, bdUduAnt);
      const equipeSete = consolidar(accsEquipe.sete, duracaoMinSeg, bdSete);
      const equipeSeteAnt = consolidar(accsEquipe.seteAnt, duracaoMinSeg, bdSeteAnt);
      const equipeQuinze = consolidar(accsEquipe.quinze, duracaoMinSeg, bdQuinze);
      const equipeQuinzeAnt = consolidar(accsEquipe.quinzeAnt, duracaoMinSeg, bdQuinzeAnt);
      const equipeTrinta = consolidar(accsEquipe.trinta, duracaoMinSeg, bdTrinta);
      const equipeTrintaAnt = consolidar(accsEquipe.trintaAnt, duracaoMinSeg, bdTrintaAnt);

      // Variacao percentual atual vs anterior na metrica principal (media/dia).
      // Retorna null quando nao ha base de comparacao (anterior = 0).
      const calcVariacaoPct = (atual: number, anterior: number): number | null => {
        if (anterior === 0) return atual === 0 ? 0 : null;
        return Math.round(((atual - anterior) / anterior) * 1000) / 10;
      };

      // Compara hoje contra UDU (ultimo dia util) — pula fds/feriados.
      const equipe = {
        hoje: {
          ...equipeHoje,
          mediaOcioSeg: ocioEquipeHoje,
          anterior: {
            total: equipeUdu.total,
            mediaPorDia: equipeUdu.mediaPorDia,
          },
          variacaoPct: calcVariacaoPct(equipeHoje.total, equipeUdu.total),
        },
        ultimoDiaUtil: {
          ...equipeUdu,
          dataReferencia: uduIni.toISOString().slice(0, 10),
          anterior: {
            total: equipeUduAnt.total,
            mediaPorDia: equipeUduAnt.mediaPorDia,
            dataReferencia: uduAntIni.toISOString().slice(0, 10),
          },
          variacaoPct: calcVariacaoPct(equipeUdu.total, equipeUduAnt.total),
        },
        sete: {
          ...equipeSete,
          mediaOcioSeg: ocioEquipeSete,
          anterior: {
            total: equipeSeteAnt.total,
            mediaPorDia: equipeSeteAnt.mediaPorDia,
          },
          variacaoPct: calcVariacaoPct(equipeSete.mediaPorDia, equipeSeteAnt.mediaPorDia),
        },
        quinze: {
          ...equipeQuinze,
          mediaOcioSeg: ocioEquipeQuinze,
          anterior: {
            total: equipeQuinzeAnt.total,
            mediaPorDia: equipeQuinzeAnt.mediaPorDia,
          },
          variacaoPct: calcVariacaoPct(equipeQuinze.mediaPorDia, equipeQuinzeAnt.mediaPorDia),
        },
        trinta: {
          ...equipeTrinta,
          mediaOcioSeg: ocioEquipeTrinta,
          anterior: {
            total: equipeTrintaAnt.total,
            mediaPorDia: equipeTrintaAnt.mediaPorDia,
          },
          variacaoPct: calcVariacaoPct(equipeTrinta.mediaPorDia, equipeTrintaAnt.mediaPorDia),
        },
      };

      // 5. Por recrutador: consolida + nota + insights
      const totaisRecs = Array.from(accs.values()).map((b) => b.trinta.total);
      const volumeMax = Math.max(1, ...totaisRecs);
      const duracaoAlvoSeg = duracaoMinSeg * 1.5;

      const recrutadoresPromises = Array.from(accs.entries()).map(async ([nome, b]) => {
        const c = {
          hoje: consolidar(b.hoje, duracaoMinSeg, bdHoje),
          sete: consolidar(b.sete, duracaoMinSeg, bdSete),
          trinta: consolidar(b.trinta, duracaoMinSeg, bdTrinta),
        };

        // Tempo ocioso do recrutador (mesma logica do equipe, mas
        // limitado ao recrutador). 3 janelas pareadas com c.
        const entriesRec = entriesPorRec.get(nome) ?? [];
        const ocio = {
          hoje: calcOcioMedioSeg(entriesNaJanela(entriesRec, hojeIni)),
          sete: calcOcioMedioSeg(entriesNaJanela(entriesRec, seteIni)),
          trinta: calcOcioMedioSeg(entriesNaJanela(entriesRec, trintaInicio)),
        };

        const trinta = c.trinta;
        const nVolume = (trinta.total / volumeMax) * 10;
        const nValidas = (trinta.taxaValidasPct / 100) * 10;
        let nDuracao = 0;
        if (trinta.mediaDuracaoSeg > 0 && duracaoAlvoSeg > 0) {
          const dist = Math.abs(trinta.mediaDuracaoSeg - duracaoAlvoSeg);
          nDuracao = Math.max(0, 10 - (dist / duracaoAlvoSeg) * 10);
        }
        const nAderencia =
          trinta.mediaAderenciaPct != null ? trinta.mediaAderenciaPct / 10 : null;
        const criterios = [nVolume, nValidas, nDuracao];
        if (nAderencia != null) criterios.push(nAderencia);
        const nota =
          Math.round((criterios.reduce((s, x) => s + x, 0) / criterios.length) * 10) / 10;

        // Insights: tenta cache LLM. Sem cache, usa rule-based agora e
        // dispara LLM em background pra preencher cache pra proxima carga.
        const insightsArgs = {
          nome,
          hoje: c.hoje,
          sete: c.sete,
          trinta: c.trinta,
          equipe: equipe.trinta,
          duracaoMinMin,
        };
        let insights: string[];
        let insightsFonte: 'ia' | 'regra' = 'regra';
        const cachedIA = await lerInsightsCacheado(insightsArgs);
        if (cachedIA && cachedIA.length > 0) {
          insights = cachedIA;
          insightsFonte = 'ia';
        } else {
          insights = gerarInsights(c.hoje, c.sete, c.trinta, duracaoMinSeg, equipe.trinta);
          dispararGeracaoEmBackground(insightsArgs);
        }

        return {
          recrutador: nome,
          periodos: c,
          ocio,
          nota,
          insights,
          insightsFonte,
          notaCriterios: {
            volume: Math.round(nVolume * 10) / 10,
            validas: Math.round(nValidas * 10) / 10,
            duracao: Math.round(nDuracao * 10) / 10,
            aderencia: nAderencia != null ? Math.round(nAderencia * 10) / 10 : null,
          },
        };
      });
      const recrutadores = await Promise.all(recrutadoresPromises);
      recrutadores.sort((a, b) => b.nota - a.nota);

      // ───────────────────────────────────────────────────────────────
      // 6. KPIs de Dias de Teste — gasto por período
      // ───────────────────────────────────────────────────────────────
      // Query agendamentos com data >= 60d atras (mesma janela das
      // entrevistas), JOIN com processo pra filtrar vaga/dept, soma de
      // valor_a_pagar quando NOT NULL (decisao final tomada). Aplica
      // filtros de custo (custoMin/custoMax) na propria query.
      const dtParams: unknown[] = [sessenta.toISOString().slice(0, 10)];
      let dtWhere = `a.data >= $1 AND a.status != 'cancelado'`;
      if (vagaFiltro) {
        dtParams.push(`%${vagaFiltro}%`);
        dtWhere += ` AND ps.vaga_snapshot ILIKE $${dtParams.length}`;
      }
      if (departamentoId != null) {
        dtParams.push(departamentoId);
        dtWhere += ` AND ps.departamento_id = $${dtParams.length}`;
      }
      if (custoMin != null) {
        dtParams.push(custoMin);
        dtWhere += ` AND COALESCE(a.valor_a_pagar, a.valor_diaria) >= $${dtParams.length}`;
      }
      if (custoMax != null) {
        dtParams.push(custoMax);
        dtWhere += ` AND COALESCE(a.valor_a_pagar, a.valor_diaria) <= $${dtParams.length}`;
      }
      const diasTesteRows = await query<{
        data: string;
        valor: string;
        status: string;
        vaga: string | null;
        departamento_id: number | null;
      }>(
        `SELECT a.data::text AS data,
                COALESCE(a.valor_a_pagar, a.valor_diaria)::text AS valor,
                a.status,
                ps.vaga_snapshot AS vaga,
                ps.departamento_id
           FROM people.dia_teste_agendamento a
           JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
          WHERE ${dtWhere}`,
        dtParams,
      );

      type ChavePerDT = 'hoje' | 'udu' | 'uduAnt' | 'sete' | 'seteAnt' | 'quinze' | 'quinzeAnt' | 'trinta' | 'trintaAnt';
      interface DTBucket {
        totalCents: number;
        count: number;
        aprovados: number;
        reprovados: number;
        compareceu: number;
        naoCompareceu: number;
        desistencia: number;
        agendado: number;
      }
      const novoDT = (): DTBucket => ({
        totalCents: 0,
        count: 0,
        aprovados: 0,
        reprovados: 0,
        compareceu: 0,
        naoCompareceu: 0,
        desistencia: 0,
        agendado: 0,
      });
      const dtAcc: Record<ChavePerDT, DTBucket> = {
        hoje: novoDT(),
        udu: novoDT(),
        uduAnt: novoDT(),
        sete: novoDT(),
        seteAnt: novoDT(),
        quinze: novoDT(),
        quinzeAnt: novoDT(),
        trinta: novoDT(),
        trintaAnt: novoDT(),
      };
      const bumpDT = (p: ChavePerDT, valorCents: number, status: string) => {
        const b = dtAcc[p];
        b.totalCents += valorCents;
        b.count++;
        switch (status) {
          case 'aprovado':
            b.aprovados++;
            break;
          case 'reprovado':
            b.reprovados++;
            break;
          case 'compareceu':
            b.compareceu++;
            break;
          case 'nao_compareceu':
            b.naoCompareceu++;
            break;
          case 'desistencia':
            b.desistencia++;
            break;
          case 'agendado':
            b.agendado++;
            break;
        }
      };
      for (const row of diasTesteRows.rows) {
        // data é yyyy-mm-dd. Constrói Date em local TZ midnight pra
        // bater com hojeIni/uduIni etc (que também são midnight local).
        const [y, m, d] = row.data.split('-').map((x) => parseInt(x, 10));
        const dt = new Date(y, m - 1, d);
        if (!isBusinessDay(dt)) continue;
        const valorCents = Math.round(parseFloat(row.valor || '0') * 100);
        if (!Number.isFinite(valorCents) || valorCents < 0) continue;

        const dtT = dt.getTime();
        const inTrinta = dtT >= trintaInicio.getTime();
        const inSete = dtT >= seteIni.getTime();
        const inHoje = dtT >= hojeIni.getTime();

        const st = row.status;
        if (inTrinta) bumpDT('trinta', valorCents, st);
        else bumpDT('trintaAnt', valorCents, st);
        if (dtT >= quinzeIni.getTime()) bumpDT('quinze', valorCents, st);
        else if (dtT >= quinzeAntIni.getTime()) bumpDT('quinzeAnt', valorCents, st);
        if (inSete) bumpDT('sete', valorCents, st);
        else if (dtT >= seteAntIni.getTime()) bumpDT('seteAnt', valorCents, st);
        if (dtT >= uduIni.getTime() && dtT < uduFim.getTime()) bumpDT('udu', valorCents, st);
        else if (dtT >= uduAntIni.getTime() && dtT < uduAntFim.getTime()) bumpDT('uduAnt', valorCents, st);
        if (inHoje) bumpDT('hoje', valorCents, st);
      }

      // Helper consolida cada período de dias de teste em formato comum:
      // total (cents), count, mediaPorDia (cents/dia útil), anterior + variacaoPct.
      function consolidarDT(
        atual: { totalCents: number; count: number },
        anterior: { totalCents: number; count: number },
        bd: number,
        bdAnt: number,
      ) {
        const mediaPorDia = bd > 0 ? atual.totalCents / bd : 0;
        const mediaAnt = bdAnt > 0 ? anterior.totalCents / bdAnt : 0;
        return {
          totalCents: atual.totalCents,
          count: atual.count,
          mediaPorDiaCents: Math.round(mediaPorDia),
          anterior: {
            totalCents: anterior.totalCents,
            count: anterior.count,
            mediaPorDiaCents: Math.round(mediaAnt),
          },
          variacaoPct: calcVariacaoPct(mediaPorDia, mediaAnt),
        };
      }

      const diasTeste = {
        ultimoDiaUtil: {
          ...consolidarDT(dtAcc.udu, dtAcc.uduAnt, bdUdu, bdUduAnt),
          dataReferencia: uduIni.toISOString().slice(0, 10),
        },
        hoje: {
          ...consolidarDT(dtAcc.hoje, dtAcc.udu, bdHoje, bdUdu),
        },
        sete: consolidarDT(dtAcc.sete, dtAcc.seteAnt, bdSete, bdSeteAnt),
        quinze: consolidarDT(dtAcc.quinze, dtAcc.quinzeAnt, bdQuinze, bdQuinzeAnt),
        trinta: consolidarDT(dtAcc.trinta, dtAcc.trintaAnt, bdTrinta, bdTrintaAnt),
      };

      // Consolidação operacional — counts e taxas por bucket.
      function consolidarDTOps(atual: DTBucket, anterior: DTBucket) {
        const decididos = atual.aprovados + atual.reprovados;
        const taxaAprovacao = decididos > 0
          ? Math.round((atual.aprovados / decididos) * 1000) / 10
          : null;
        const decididosAnt = anterior.aprovados + anterior.reprovados;
        const taxaAprovacaoAnt = decididosAnt > 0
          ? Math.round((anterior.aprovados / decididosAnt) * 1000) / 10
          : null;
        const pctAprovTotal = atual.count > 0
          ? Math.round((atual.aprovados / atual.count) * 1000) / 10
          : 0;
        const pctReprTotal = atual.count > 0
          ? Math.round((atual.reprovados / atual.count) * 1000) / 10
          : 0;
        const pctNoShow = atual.count > 0
          ? Math.round((atual.naoCompareceu / atual.count) * 1000) / 10
          : 0;
        return {
          total: atual.count,
          aprovados: atual.aprovados,
          reprovados: atual.reprovados,
          compareceu: atual.compareceu,
          naoCompareceu: atual.naoCompareceu,
          desistencia: atual.desistencia,
          agendado: atual.agendado,
          taxaAprovacaoPct: taxaAprovacao,
          pctAprovadosTotal: pctAprovTotal,
          pctReprovadosTotal: pctReprTotal,
          pctNaoCompareceuTotal: pctNoShow,
          anterior: {
            total: anterior.count,
            aprovados: anterior.aprovados,
            reprovados: anterior.reprovados,
            taxaAprovacaoPct: taxaAprovacaoAnt,
          },
          // Variação aplicada à taxa de aprovação. Pra Hoje/UDU, variação
          // sobre total absoluto (mesmo padrão dos KPIs de entrevistas).
          variacaoTotalPct: calcVariacaoPct(atual.count, anterior.count),
          variacaoTaxaAprovacaoPct:
            taxaAprovacaoAnt != null && taxaAprovacao != null
              ? Math.round((taxaAprovacao - taxaAprovacaoAnt) * 10) / 10
              : null,
        };
      }

      // ───────────────────────────────────────────────────────────────
      // Funil de recrutamento (30d) — entrevistas → admissão
      // ───────────────────────────────────────────────────────────────
      // Liga entrevistas (DB Recrutamento) → processo seletivo (DB People)
      // via candidato_recrutamento_id ↔ candidatos.id, usando telefone
      // como ponte entre os dois bancos. Pra cada recrutador (e total
      // agregado em "_todos"), conta candidatos em cada estágio.

      // 1. Normaliza telefones das entrevistas filtradas (apenas trinta).
      //    Map<telefoneNorm, Set<recrutador>>.
      const normTel = (t: string | null): string => {
        if (!t) return '';
        return t.replace(/\D+/g, '').replace(/^55/, '');
      };
      const telToRec = new Map<string, Set<string>>();
      const recrutadoresAtivosLista: string[] = [];
      const recrutadoresAtivosSet = new Set<string>();
      const linhasTrintaFunil = linhas.rows.filter((r) => {
        const dt = new Date(r.data_entrevista);
        return dt >= trintaInicio && isBusinessDay(dt);
      });
      for (const r of linhasTrintaFunil) {
        const k = (r.recrutador ?? '').trim();
        if (!k || !recrutadorAtivo(k)) continue;
        if (!recrutadoresAtivosSet.has(k)) {
          recrutadoresAtivosSet.add(k);
          recrutadoresAtivosLista.push(k);
        }
        const tel = normTel(r.telefone);
        if (tel.length < 8) continue;
        let s = telToRec.get(tel);
        if (!s) {
          s = new Set();
          telToRec.set(tel, s);
        }
        s.add(k);
      }

      // 2. Resolve candidato_recrutamento_id (DB Recrutamento) via telefone.
      //    candidatos.telefone também precisa ser normalizado pra match.
      const candIdToRec = new Map<number, string[]>();
      if (telToRec.size > 0) {
        const telefonesArr = Array.from(telToRec.keys());
        try {
          const candRes = await queryRecrutamento<{
            id: number;
            telefone: string;
          }>(
            `SELECT id, telefone FROM public.candidatos
              WHERE regexp_replace(regexp_replace(telefone, '\\D+', '', 'g'), '^55', '') = ANY($1::text[])`,
            [telefonesArr],
          );
          for (const c of candRes.rows) {
            const tel = normTel(c.telefone);
            const recs = telToRec.get(tel);
            if (recs && recs.size > 0) {
              candIdToRec.set(c.id, Array.from(recs));
            }
          }
        } catch (e) {
          console.warn('[funil] busca candidatos falhou:', e);
        }
      }

      // 3. Acumuladores por recrutador. "_todos" agrega total geral.
      interface FunilBucket {
        entrevistas: number;
        processos: number;
        testesAgendados: number;
        compareceu: number;
        aprovados: number;
        admitidos: number;
      }
      const novoFunil = (): FunilBucket => ({
        entrevistas: 0,
        processos: 0,
        testesAgendados: 0,
        compareceu: 0,
        aprovados: 0,
        admitidos: 0,
      });
      const funilAcc = new Map<string, FunilBucket>();
      funilAcc.set('_todos', novoFunil());
      for (const r of recrutadoresAtivosLista) {
        funilAcc.set(r, novoFunil());
      }
      const bumpFunil = (rec: string | null, key: keyof FunilBucket) => {
        funilAcc.get('_todos')![key]++;
        if (rec && funilAcc.has(rec)) funilAcc.get(rec)![key]++;
      };

      // Estágio 1: entrevistas (já temos linhasTrintaFunil).
      for (const r of linhasTrintaFunil) {
        const k = (r.recrutador ?? '').trim();
        if (!k || !recrutadorAtivo(k)) continue;
        bumpFunil(k, 'entrevistas');
      }

      // Estágio 2-6: processos seletivos + testes + admissões.
      // Filtra pela mesma janela trinta (data de criação do processo).
      // Status terminal do processo: admitido. Estados intermediários
      // (dia_teste / em_admissao) contam apenas como "processo".
      try {
        const procRes = await query<{
          id: string;
          candidato_recrutamento_id: number | null;
          status: string;
          admitido_em: Date | null;
          criado_em: Date;
        }>(
          `SELECT id::text AS id,
                  candidato_recrutamento_id,
                  status,
                  admitido_em,
                  criado_em
             FROM people.processo_seletivo
            WHERE criado_em >= $1`,
          [trintaInicio.toISOString()],
        );

        // Map<processo_id, recrutador_atribuido> — usa primeiro recrutador
        // se candidato passou por entrevistas com múltiplos.
        const procToRec = new Map<string, string | null>();
        for (const p of procRes.rows) {
          if (!p.candidato_recrutamento_id) {
            procToRec.set(p.id, null);
            continue;
          }
          const recs = candIdToRec.get(p.candidato_recrutamento_id);
          const rec = recs && recs.length > 0 ? recs[0] : null;
          procToRec.set(p.id, rec);
          bumpFunil(rec, 'processos');
          if (p.status === 'admitido' || p.admitido_em != null) {
            bumpFunil(rec, 'admitidos');
          }
        }

        // Estágio dia_teste — counts por processo.
        // Agendado = "testesAgendados". Compareceu/aprovado/reprovado =
        // "compareceu" (presença confirmada). Apenas aprovado conta
        // também em "aprovados".
        const procIds = Array.from(procToRec.keys());
        if (procIds.length > 0) {
          const dtFunilRes = await query<{
            processo_seletivo_id: string;
            status: string;
          }>(
            `SELECT processo_seletivo_id::text AS processo_seletivo_id, status
               FROM people.dia_teste_agendamento
              WHERE processo_seletivo_id = ANY($1::bigint[])
                AND status != 'cancelado'`,
            [procIds],
          );
          // Pra evitar double-counting quando processo tem múltiplos dias,
          // marcamos por processo o estágio mais avançado atingido.
          interface ProcEstagio {
            agendou: boolean;
            compareceu: boolean;
            aprovado: boolean;
          }
          const procEstagios = new Map<string, ProcEstagio>();
          for (const a of dtFunilRes.rows) {
            const pid = a.processo_seletivo_id;
            let est = procEstagios.get(pid);
            if (!est) {
              est = { agendou: false, compareceu: false, aprovado: false };
              procEstagios.set(pid, est);
            }
            est.agendou = true;
            if (['compareceu', 'aprovado', 'reprovado'].includes(a.status)) {
              est.compareceu = true;
            }
            if (a.status === 'aprovado') est.aprovado = true;
          }
          for (const [pid, est] of procEstagios.entries()) {
            const rec = procToRec.get(pid) ?? null;
            if (est.agendou) bumpFunil(rec, 'testesAgendados');
            if (est.compareceu) bumpFunil(rec, 'compareceu');
            if (est.aprovado) bumpFunil(rec, 'aprovados');
          }
        }
      } catch (e) {
        console.warn('[funil] busca processos/testes falhou:', e);
      }

      const funilRecrutamento = {
        recrutadores: recrutadoresAtivosLista.sort(),
        buckets: Object.fromEntries(funilAcc.entries()),
      };

      const diasTesteOps = {
        ultimoDiaUtil: {
          ...consolidarDTOps(dtAcc.udu, dtAcc.uduAnt),
          dataReferencia: uduIni.toISOString().slice(0, 10),
        },
        hoje: consolidarDTOps(dtAcc.hoje, dtAcc.udu),
        sete: consolidarDTOps(dtAcc.sete, dtAcc.seteAnt),
        quinze: consolidarDTOps(dtAcc.quinze, dtAcc.quinzeAnt),
        trinta: consolidarDTOps(dtAcc.trinta, dtAcc.trintaAnt),
      };

      // 8. Opcoes (cacheado 5min — listas mudam raro)
      const opcoes = await cacheAside(
        'recrutamento:relatorio:opcoes:v1',
        async () => {
          const [recsRes, vagasRes, deptsRes] = await Promise.all([
            queryRecrutamento<{ recrutador: string }>(
              `SELECT DISTINCT recrutador
                 FROM public.entrevistas_agendadas
                WHERE recrutador IS NOT NULL AND recrutador <> ''
                ORDER BY recrutador`,
            ),
            queryRecrutamento<{ vaga: string }>(
              `SELECT DISTINCT vaga
                 FROM public.entrevistas_agendadas
                WHERE vaga IS NOT NULL AND vaga <> ''
                ORDER BY vaga`,
            ),
            queryRecrutamento<{ id: number; valor: string }>(
              `SELECT DISTINCT o.id, o.valor
                 FROM public.vagas v
                 JOIN public.opcoes o ON o.id = v.departamento_id
                WHERE o.valor IS NOT NULL AND o.valor <> ''
                ORDER BY o.valor`,
            ),
          ]);
          return {
            recrutadores: recsRes.rows.map((r) => r.recrutador),
            vagas: vagasRes.rows.map((r) => r.vaga),
            departamentos: deptsRes.rows.map((r) => ({
              id: r.id,
              nome: r.valor,
            })),
          };
        },
        CACHE_TTL.MEDIUM,
      );

      return {
        parametros: {
          duracaoMinimaMinutos: duracaoMinMin,
          duracaoMinSegEfetivo: duracaoMinSeg,
          duracaoAlvoSeg,
          diasUteis: {
            hoje: bdHoje,
            udu: bdUdu,
            uduAnt: bdUduAnt,
            sete: bdSete,
            seteAnt: bdSeteAnt,
            quinze: bdQuinze,
            quinzeAnt: bdQuinzeAnt,
            trinta: bdTrinta,
            trintaAnt: bdTrintaAnt,
          },
          ultimoDiaUtil: uduIni.toISOString().slice(0, 10),
          ultimoDiaUtilAnterior: uduAntIni.toISOString().slice(0, 10),
        },
        equipe,
        recrutadores,
        diasTeste,
        diasTesteOps,
        funilRecrutamento,
        opcoes: {
          ...opcoes,
          // Filtra dropdown: so recrutadores com usuario ativo cargo
          // recrutador no People.
          recrutadores: opcoes.recrutadores.filter((nome) => recrutadorAtivo(nome)),
        },
      };
      }, CACHE_TTL.SHORT);

      return successResponse(dashboard);
    } catch (error) {
      console.error('[recrutamento/relatorio/dashboard] erro:', error);
      return serverErrorResponse('Erro ao gerar dashboard');
    }
  });
}
