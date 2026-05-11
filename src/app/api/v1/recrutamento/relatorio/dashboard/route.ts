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
  data_entrevista: Date;
  duracao_seg: number | null;
  aderencia_ia_pct: string | null;
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
      const cacheKey = `recrutamento:relatorio:dashboard:v3:${[
        recrutadorFiltro ?? '*',
        vagaFiltro ?? '*',
        departamentoId ?? '*',
        duracaoMinSeg,
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
        `SELECT id, recrutador, data_entrevista, duracao_seg, aderencia_ia_pct
           FROM public.entrevistas_agendadas
          WHERE ${where}`,
        params,
      );

      const hojeIni = new Date();
      hojeIni.setHours(0, 0, 0, 0);
      const ontemIni = new Date(hojeIni.getTime() - 1 * 24 * 60 * 60 * 1000);
      const seteIni = new Date(hojeIni.getTime() - 7 * 24 * 60 * 60 * 1000);
      const seteAntIni = new Date(hojeIni.getTime() - 14 * 24 * 60 * 60 * 1000);

      // 4. Agrega por recrutador × periodo (3 janelas).
      // No nivel equipe agrega tambem janelas anteriores (ontem / 7d ant /
      // 30d ant) pra calcular variacao percentual nos KPIs do topo.
      type ChavePer = 'hoje' | 'sete' | 'trinta';
      type ChavePerEquipe =
        | 'hoje'
        | 'ontem'
        | 'sete'
        | 'seteAnt'
        | 'trinta'
        | 'trintaAnt';
      const accs = new Map<string, Record<ChavePer, AccPeriodo>>();
      const accsEquipe: Record<ChavePerEquipe, AccPeriodo> = {
        hoje: novoAcc(),
        ontem: novoAcc(),
        sete: novoAcc(),
        seteAnt: novoAcc(),
        trinta: novoAcc(),
        trintaAnt: novoAcc(),
      };

      // Pra serie diaria 30d (visao geral)
      const serieMap = new Map<string, { total: number; somaDur: number; comDur: number }>();

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

        // Equipe: janelas atuais + anteriores pra variacao percentual.
        if (inTrinta) aplicarAcc(accsEquipe.trinta);
        else aplicarAcc(accsEquipe.trintaAnt);
        if (inSete) aplicarAcc(accsEquipe.sete);
        else if (dt >= seteAntIni) aplicarAcc(accsEquipe.seteAnt);
        if (inHoje) aplicarAcc(accsEquipe.hoje);
        else if (dt >= ontemIni) aplicarAcc(accsEquipe.ontem);

        // Serie diaria 30d: pula registros mais antigos
        if (!inTrinta) continue;
        let s = serieMap.get(dia);
        if (!s) {
          s = { total: 0, somaDur: 0, comDur: 0 };
          serieMap.set(dia, s);
        }
        s.total++;
        if (r.duracao_seg != null) {
          s.somaDur += r.duracao_seg;
          s.comDur++;
        }
      }

      // Dias úteis em cada janela — denominador do mediaPorDia.
      // hoje/ontem = 0 ou 1; demais somam seg-sex sem feriados.
      const bdHoje = isBusinessDay(hojeIni) ? 1 : 0;
      const bdOntem = isBusinessDay(ontemIni) ? 1 : 0;
      const bdSete = countBusinessDays(seteIni, hojeIni);
      const seteAntFim = new Date(seteIni.getTime() - 24 * 60 * 60 * 1000);
      const bdSeteAnt = countBusinessDays(seteAntIni, seteAntFim);
      const bdTrinta = countBusinessDays(trintaInicio, hojeIni);
      const trintaAntFim = new Date(trintaInicio.getTime() - 24 * 60 * 60 * 1000);
      const bdTrintaAnt = countBusinessDays(sessenta, trintaAntFim);

      const equipeHoje = consolidar(accsEquipe.hoje, duracaoMinSeg, bdHoje);
      const equipeOntem = consolidar(accsEquipe.ontem, duracaoMinSeg, bdOntem);
      const equipeSete = consolidar(accsEquipe.sete, duracaoMinSeg, bdSete);
      const equipeSeteAnt = consolidar(accsEquipe.seteAnt, duracaoMinSeg, bdSeteAnt);
      const equipeTrinta = consolidar(accsEquipe.trinta, duracaoMinSeg, bdTrinta);
      const equipeTrintaAnt = consolidar(accsEquipe.trintaAnt, duracaoMinSeg, bdTrintaAnt);

      // Variacao percentual atual vs anterior na metrica principal (media/dia).
      // Retorna null quando nao ha base de comparacao (anterior = 0).
      const calcVariacaoPct = (atual: number, anterior: number): number | null => {
        if (anterior === 0) return atual === 0 ? 0 : null;
        return Math.round(((atual - anterior) / anterior) * 1000) / 10;
      };

      const equipe = {
        hoje: {
          ...equipeHoje,
          anterior: {
            total: equipeOntem.total,
            mediaPorDia: equipeOntem.mediaPorDia,
          },
          variacaoPct: calcVariacaoPct(equipeHoje.mediaPorDia, equipeOntem.mediaPorDia),
        },
        sete: {
          ...equipeSete,
          anterior: {
            total: equipeSeteAnt.total,
            mediaPorDia: equipeSeteAnt.mediaPorDia,
          },
          variacaoPct: calcVariacaoPct(equipeSete.mediaPorDia, equipeSeteAnt.mediaPorDia),
        },
        trinta: {
          ...equipeTrinta,
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

      // 6. Serie diaria 30d (só dias úteis — fds/feriados são omitidos
      // do eixo X pra evitar gaps de zero que distorcem visualmente).
      const serieDiaria30d: { data: string; total: number; mediaDuracaoSeg: number }[] = [];
      const cur = new Date(trintaInicio);
      const fim = new Date();
      fim.setHours(0, 0, 0, 0);
      while (cur <= fim) {
        if (isBusinessDay(cur)) {
          const k = cur.toISOString().slice(0, 10);
          const s = serieMap.get(k);
          serieDiaria30d.push({
            data: k,
            total: s?.total ?? 0,
            mediaDuracaoSeg: s && s.comDur > 0 ? Math.round(s.somaDur / s.comDur) : 0,
          });
        }
        cur.setDate(cur.getDate() + 1);
      }

      // 7. Distribuicao por bucket de duracao (30d, apenas dias úteis).
      const linhasTrinta = linhas.rows.filter((r) => {
        const dt = new Date(r.data_entrevista);
        return dt >= trintaInicio && isBusinessDay(dt);
      });
      const buckets = [
        { label: '< 5min', min: 0, max: 5 * 60 },
        { label: '5–10', min: 5 * 60, max: 10 * 60 },
        { label: '10–15', min: 10 * 60, max: 15 * 60 },
        { label: '15–30', min: 15 * 60, max: 30 * 60 },
        { label: '30+', min: 30 * 60, max: Number.POSITIVE_INFINITY },
      ];
      const distribuicao = buckets.map((b) => {
        const qty = linhasTrinta.filter(
          (r) =>
            r.duracao_seg != null &&
            r.duracao_seg >= b.min &&
            r.duracao_seg < b.max,
        ).length;
        return { label: b.label, total: qty };
      });
      const semDuracao = linhasTrinta.filter((r) => r.duracao_seg == null).length;

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
            ontem: bdOntem,
            sete: bdSete,
            seteAnt: bdSeteAnt,
            trinta: bdTrinta,
            trintaAnt: bdTrintaAnt,
          },
        },
        equipe,
        recrutadores,
        serieDiaria30d,
        distribuicaoDuracao: {
          buckets: distribuicao,
          semDuracaoRegistrada: semDuracao,
        },
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
