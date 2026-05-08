import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  serverErrorResponse,
} from '@/lib/api-response';

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

function consolidar(acc: AccPeriodo, duracaoMinSeg: number) {
  const mediaDuracaoSeg =
    acc.comDuracao > 0 ? Math.round(acc.somaDuracao / acc.comDuracao) : 0;
  const taxaValidas = acc.comDuracao > 0 ? acc.validas / acc.comDuracao : 0;
  const dias = acc.diasUnicos.size || 0;
  const mediaPorDia = dias > 0 ? acc.total / dias : 0;
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

      // 3. Sempre carrega 30d (engloba 7d + hoje). Filtra na memoria.
      const trinta = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      trinta.setHours(0, 0, 0, 0);

      const params: unknown[] = [trinta.toISOString()];
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
      const seteIni = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      seteIni.setHours(0, 0, 0, 0);

      // 4. Agrega por recrutador × periodo
      type ChavePer = 'hoje' | 'sete' | 'trinta';
      const accs = new Map<string, Record<ChavePer, AccPeriodo>>();
      const accsEquipe: Record<ChavePer, AccPeriodo> = {
        hoje: novoAcc(),
        sete: novoAcc(),
        trinta: novoAcc(),
      };

      // Pra serie diaria 30d (visao geral)
      const serieMap = new Map<string, { total: number; somaDur: number; comDur: number }>();

      for (const r of linhas.rows) {
        const k = (r.recrutador ?? 'sem_recrutador').trim() || 'sem_recrutador';
        const dt = new Date(r.data_entrevista);
        const dia = dt.toISOString().slice(0, 10);

        let bucket = accs.get(k);
        if (!bucket) {
          bucket = { hoje: novoAcc(), sete: novoAcc(), trinta: novoAcc() };
          accs.set(k, bucket);
        }

        const aderencia =
          r.aderencia_ia_pct != null ? Number(r.aderencia_ia_pct) : null;

        const aplicar = (p: ChavePer) => {
          const a = bucket![p];
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
          // Equipe
          const e = accsEquipe[p];
          e.total++;
          e.diasUnicos.add(dia);
          e.datasOrdenadas.push(dt.getTime());
          if (r.duracao_seg != null) {
            e.somaDuracao += r.duracao_seg;
            e.comDuracao++;
            if (r.duracao_seg >= duracaoMinSeg) e.validas++;
          }
          if (aderencia != null && Number.isFinite(aderencia)) {
            e.somaAderencia += aderencia;
            e.comAderencia++;
          }
        };

        // sempre cai em 30
        aplicar('trinta');
        if (dt >= seteIni) aplicar('sete');
        if (dt >= hojeIni) aplicar('hoje');

        // Serie diaria 30d
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

      const equipe = {
        hoje: consolidar(accsEquipe.hoje, duracaoMinSeg),
        sete: consolidar(accsEquipe.sete, duracaoMinSeg),
        trinta: consolidar(accsEquipe.trinta, duracaoMinSeg),
      };

      // 5. Por recrutador: consolida + nota + insights
      const totaisRecs = Array.from(accs.values()).map((b) => b.trinta.total);
      const volumeMax = Math.max(1, ...totaisRecs);
      const duracaoAlvoSeg = duracaoMinSeg * 1.5;

      const recrutadores = Array.from(accs.entries()).map(([nome, b]) => {
        const c = {
          hoje: consolidar(b.hoje, duracaoMinSeg),
          sete: consolidar(b.sete, duracaoMinSeg),
          trinta: consolidar(b.trinta, duracaoMinSeg),
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

        const insights = gerarInsights(c.hoje, c.sete, c.trinta, duracaoMinSeg, equipe.trinta);

        return {
          recrutador: nome,
          periodos: c,
          nota,
          insights,
          // Componentes da nota (transparencia)
          notaCriterios: {
            volume: Math.round(nVolume * 10) / 10,
            validas: Math.round(nValidas * 10) / 10,
            duracao: Math.round(nDuracao * 10) / 10,
            aderencia: nAderencia != null ? Math.round(nAderencia * 10) / 10 : null,
          },
        };
      });
      recrutadores.sort((a, b) => b.nota - a.nota);

      // 6. Serie diaria 30d (preenche dias vazios com 0)
      const serieDiaria30d: { data: string; total: number; mediaDuracaoSeg: number }[] = [];
      const cur = new Date(trinta);
      const fim = new Date();
      fim.setHours(0, 0, 0, 0);
      while (cur <= fim) {
        const k = cur.toISOString().slice(0, 10);
        const s = serieMap.get(k);
        serieDiaria30d.push({
          data: k,
          total: s?.total ?? 0,
          mediaDuracaoSeg: s && s.comDur > 0 ? Math.round(s.somaDur / s.comDur) : 0,
        });
        cur.setDate(cur.getDate() + 1);
      }

      // 7. Distribuicao por bucket de duracao (30d)
      const buckets = [
        { label: '< 5min', min: 0, max: 5 * 60 },
        { label: '5–10', min: 5 * 60, max: 10 * 60 },
        { label: '10–15', min: 10 * 60, max: 15 * 60 },
        { label: '15–30', min: 15 * 60, max: 30 * 60 },
        { label: '30+', min: 30 * 60, max: Number.POSITIVE_INFINITY },
      ];
      const distribuicao = buckets.map((b) => {
        const qty = linhas.rows.filter(
          (r) =>
            r.duracao_seg != null &&
            r.duracao_seg >= b.min &&
            r.duracao_seg < b.max,
        ).length;
        return { label: b.label, total: qty };
      });
      const semDuracao = linhas.rows.filter((r) => r.duracao_seg == null).length;

      // 8. Opcoes
      const [recrutadoresDistintosRes, vagasDistintasRes, departamentosRes] =
        await Promise.all([
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

      return successResponse({
        parametros: {
          duracaoMinimaMinutos: duracaoMinMin,
          duracaoMinSegEfetivo: duracaoMinSeg,
          duracaoAlvoSeg,
        },
        equipe,
        recrutadores,
        serieDiaria30d,
        distribuicaoDuracao: {
          buckets: distribuicao,
          semDuracaoRegistrada: semDuracao,
        },
        opcoes: {
          recrutadores: recrutadoresDistintosRes.rows.map((r) => r.recrutador),
          vagas: vagasDistintasRes.rows.map((r) => r.vaga),
          departamentos: departamentosRes.rows.map((r) => ({
            id: r.id,
            nome: r.valor,
          })),
        },
      });
    } catch (error) {
      console.error('[recrutamento/relatorio/dashboard] erro:', error);
      return serverErrorResponse('Erro ao gerar dashboard');
    }
  });
}
