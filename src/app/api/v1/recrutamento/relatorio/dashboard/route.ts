import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/relatorio/dashboard
//
// Dashboard agregado de entrevistas:
//  - Globais: total hoje, 7d, 30d
//  - Por recrutador: total, media_duracao_seg, media_entrevistas_dia,
//    taxa_validas (>= duracao_minima_entrevista_minutos), nota 0-10
//  - Distribuicao por bucket de duracao (<5, 5-10, 10-15, 15-30, 30+)
//
// Query params (todos opcionais):
//  - dataInicio (YYYY-MM-DD)  default: hoje - 30
//  - dataFim    (YYYY-MM-DD)  default: hoje
//  - recrutador (string)      filtra por recrutador
//  - duracaoMinSeg (int)      override do parametro global
//
// Aderencia IA fica pra fase 2 (depende de LLM).

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const recrutadorFiltro = searchParams.get('recrutador')?.trim() || null;
      const duracaoMinSegOverride = searchParams.get('duracaoMinSeg');

      // 1. Le parametro global pra duracao minima
      const paramRes = await query<{ duracao_minima_entrevista_minutos: number }>(
        `SELECT duracao_minima_entrevista_minutos FROM people.parametros_rh LIMIT 1`,
      );
      const duracaoMinMin =
        paramRes.rows[0]?.duracao_minima_entrevista_minutos ?? 5;
      const duracaoMinSeg = duracaoMinSegOverride
        ? Math.max(0, parseInt(duracaoMinSegOverride, 10))
        : duracaoMinMin * 60;

      // 2. Periodo (default ultimos 30 dias)
      const hoje = new Date();
      const fimDate = dataFim ? new Date(dataFim + 'T23:59:59') : new Date(hoje);
      fimDate.setHours(23, 59, 59, 999);
      const inicioDate = dataInicio
        ? new Date(dataInicio + 'T00:00:00')
        : new Date(hoje.getTime() - 30 * 24 * 60 * 60 * 1000);
      inicioDate.setHours(0, 0, 0, 0);

      const params: unknown[] = [inicioDate.toISOString(), fimDate.toISOString()];
      let where = `data_entrevista >= $1 AND data_entrevista <= $2`;
      if (recrutadorFiltro) {
        params.push(recrutadorFiltro);
        where += ` AND recrutador = $${params.length}`;
      }

      // 3. Snapshot bruto: tudo do periodo (com duracao_seg quando tiver)
      const linhas = await queryRecrutamento<{
        id: number;
        recrutador: string | null;
        data_entrevista: string;
        duracao_seg: number | null;
        houve_entrevista_ia: boolean | null;
        nota_entrevistador_ia: string | null;
      }>(
        `SELECT id, recrutador, data_entrevista, duracao_seg,
                houve_entrevista_ia, nota_entrevistador_ia
           FROM public.entrevistas_agendadas
          WHERE ${where}`,
        params,
      );

      // 4. Totais "hoje", 7d, 30d (independente de filtro de periodo —
      //    mas respeitam recrutador). Reconsulta com janelas fixas.
      const baseHojeIni = new Date();
      baseHojeIni.setHours(0, 0, 0, 0);
      const base7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const base30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const totaisQuery = recrutadorFiltro
        ? `SELECT
             SUM(CASE WHEN data_entrevista >= $1 THEN 1 ELSE 0 END)::int AS hoje,
             SUM(CASE WHEN data_entrevista >= $2 THEN 1 ELSE 0 END)::int AS sete,
             SUM(CASE WHEN data_entrevista >= $3 THEN 1 ELSE 0 END)::int AS trinta
           FROM public.entrevistas_agendadas
           WHERE recrutador = $4`
        : `SELECT
             SUM(CASE WHEN data_entrevista >= $1 THEN 1 ELSE 0 END)::int AS hoje,
             SUM(CASE WHEN data_entrevista >= $2 THEN 1 ELSE 0 END)::int AS sete,
             SUM(CASE WHEN data_entrevista >= $3 THEN 1 ELSE 0 END)::int AS trinta
           FROM public.entrevistas_agendadas`;
      const totParams: unknown[] = [
        baseHojeIni.toISOString(),
        base7d.toISOString(),
        base30d.toISOString(),
      ];
      if (recrutadorFiltro) totParams.push(recrutadorFiltro);
      const totaisRes = await queryRecrutamento<{
        hoje: number;
        sete: number;
        trinta: number;
      }>(totaisQuery, totParams);
      const totais = totaisRes.rows[0] ?? { hoje: 0, sete: 0, trinta: 0 };

      // 5. Stats por recrutador
      type Acc = {
        total: number;
        somaDuracao: number;
        comDuracao: number;
        validas: number;
        diasUnicos: Set<string>;
      };
      const acc = new Map<string, Acc>();
      for (const r of linhas.rows) {
        const k = (r.recrutador ?? 'sem_recrutador').trim() || 'sem_recrutador';
        let a = acc.get(k);
        if (!a) {
          a = { total: 0, somaDuracao: 0, comDuracao: 0, validas: 0, diasUnicos: new Set() };
          acc.set(k, a);
        }
        a.total += 1;
        a.diasUnicos.add(r.data_entrevista.slice(0, 10));
        if (r.duracao_seg != null) {
          a.somaDuracao += r.duracao_seg;
          a.comDuracao += 1;
          if (r.duracao_seg >= duracaoMinSeg) a.validas += 1;
        }
      }

      // Volume base pra normalizar nota — top recrutador define o teto
      const volumes = Array.from(acc.values()).map((a) => a.total);
      const volumeMax = Math.max(1, ...volumes);
      // Duracao alvo: 1.5x duracaoMinSeg (heuristica). Mais perto = melhor.
      const duracaoAlvoSeg = duracaoMinSeg * 1.5;

      const recrutadores = Array.from(acc.entries()).map(([nome, a]) => {
        const mediaDuracaoSeg =
          a.comDuracao > 0 ? Math.round(a.somaDuracao / a.comDuracao) : 0;
        const taxaValidas = a.comDuracao > 0 ? a.validas / a.comDuracao : 0;
        const dias = a.diasUnicos.size || 1;
        const mediaPorDia = a.total / dias;

        // Nota composta 0-10 (3 critérios — IA fica pra fase 2 com peso 0)
        // - 33% volume relativo ao top
        // - 33% taxa_validas
        // - 33% proximidade da duracao alvo
        const nVolume = (a.total / volumeMax) * 10;
        const nValidas = taxaValidas * 10;
        let nDuracao = 0;
        if (mediaDuracaoSeg > 0 && duracaoAlvoSeg > 0) {
          // Pico em duracaoAlvoSeg; cai linearmente quando se afasta.
          const dist = Math.abs(mediaDuracaoSeg - duracaoAlvoSeg);
          const escala = duracaoAlvoSeg; // 0% quando dist >= alvo
          nDuracao = Math.max(0, 10 - (dist / escala) * 10);
        }
        const nota = Math.round(((nVolume + nValidas + nDuracao) / 3) * 10) / 10;

        return {
          recrutador: nome,
          total: a.total,
          totalComDuracao: a.comDuracao,
          mediaDuracaoSeg,
          mediaEntrevistasPorDia: Math.round(mediaPorDia * 10) / 10,
          totalValidas: a.validas,
          taxaValidasPct: Math.round(taxaValidas * 1000) / 10,
          nota,
        };
      });
      recrutadores.sort((a, b) => b.nota - a.nota);

      // 6. Distribuicao por bucket de duracao (do periodo filtrado)
      const buckets = [
        { label: '< 5min', min: 0, max: 5 * 60 },
        { label: '5–10min', min: 5 * 60, max: 10 * 60 },
        { label: '10–15min', min: 10 * 60, max: 15 * 60 },
        { label: '15–30min', min: 15 * 60, max: 30 * 60 },
        { label: '30min+', min: 30 * 60, max: Number.POSITIVE_INFINITY },
      ];
      const distribuicao = buckets.map((b) => {
        const qty = linhas.rows.filter(
          (r) => r.duracao_seg != null && r.duracao_seg >= b.min && r.duracao_seg < b.max,
        ).length;
        return { label: b.label, total: qty };
      });
      const semDuracao = linhas.rows.filter((r) => r.duracao_seg == null).length;

      // 7. Lista de recrutadores distintos (pra dropdown de filtro)
      const recrutadoresDistintosRes = await queryRecrutamento<{ recrutador: string }>(
        `SELECT DISTINCT recrutador
           FROM public.entrevistas_agendadas
          WHERE recrutador IS NOT NULL AND recrutador <> ''
          ORDER BY recrutador`,
      );

      return successResponse({
        periodo: {
          dataInicio: inicioDate.toISOString().slice(0, 10),
          dataFim: fimDate.toISOString().slice(0, 10),
        },
        parametros: {
          duracaoMinimaMinutos: duracaoMinMin,
          duracaoMinSegEfetivo: duracaoMinSeg,
        },
        totais: {
          hoje: totais.hoje ?? 0,
          ultimos7Dias: totais.sete ?? 0,
          ultimos30Dias: totais.trinta ?? 0,
          noPeriodo: linhas.rows.length,
        },
        recrutadores,
        distribuicaoDuracao: {
          buckets: distribuicao,
          semDuracaoRegistrada: semDuracao,
        },
        opcoes: {
          recrutadores: recrutadoresDistintosRes.rows.map((r) => r.recrutador),
        },
      });
    } catch (error) {
      console.error('[recrutamento/relatorio/dashboard] erro:', error);
      return serverErrorResponse('Erro ao gerar dashboard');
    }
  });
}
