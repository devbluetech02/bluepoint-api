import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/relatorio-performance
//   ?de=YYYY-MM-DD&ate=YYYY-MM-DD&vaga=&uf=&recrutador=
//
// Relatório de performance dos recrutadores. Cruza:
//   1) public.candidatos no banco de Recrutamento (DigitalOcean):
//      - Entrevistado = status_entrevista IS NOT NULL E não vazio
//      - Recrutador = responsavel_entrevista (texto livre, normalizado)
//      - Período = data_entrevista
//   2) public.entrevistas_agendadas (mesmo banco): contém a análise IA da
//      entrevista. Define "entrevista válida" = candidato tem registro de
//      análise no período E `cobertura_percent` da correlação CV–entrevista
//      >= threshold (env ENTREVISTA_COBERTURA_MINIMA, default 50%).
//   3) people.processo_seletivo no banco People (Aurora):
//      - Mandado pra teste = caminho='dia_teste' (match por CPF)
//      - Aprovado = ao menos um dia_teste_agendamento status='aprovado'
//      - Admitido = processo_seletivo.status='admitido'
//
// Default de período: hoje (00:00 → 23:59) — relatório diário.

interface CandidatoRow {
  id: number;
  cpf_norm: string;
  vaga: string | null;
  uf: string | null;
  responsavel_entrevista: string | null;
  status_entrevista: string | null;
  data_entrevista: Date | null;
}

interface ProcessoRow {
  cpf_norm: string;
  caminho: string;
  status: string;
  tem_aprovado: boolean;
  criado_em: Date | null;
  atualizado_em: Date | null;
}

interface TotaisJanela {
  entrevistados: number;
  entrevistasValidas: number;
  entrevistasComAnalise: number;
  testesEnviados: number;
  aprovados: number;
  admitidos: number;
}

function diffDeltaPct(atual: number, anterior: number): number | null {
  if (anterior === 0) return atual === 0 ? 0 : null; // anterior 0 = sem base
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

function calcularPeriodoAnterior(
  de: string,
  ate: string,
): { de: string; ate: string } {
  const dDe = new Date(`${de}T00:00:00Z`);
  const dAte = new Date(`${ate}T00:00:00Z`);
  const dias = Math.round(
    (dAte.getTime() - dDe.getTime()) / (1000 * 60 * 60 * 24),
  );
  // Janela imediatamente anterior, mesma duração (de até ate inclusivos).
  const novoAte = new Date(dDe);
  novoAte.setUTCDate(novoAte.getUTCDate() - 1);
  const novoDe = new Date(novoAte);
  novoDe.setUTCDate(novoDe.getUTCDate() - dias);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { de: fmt(novoDe), ate: fmt(novoAte) };
}

function parseDateOrDefault(s: string | null, fallback: string): string {
  if (!s) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback;
  return s;
}

function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizarRecrutador(s: string | null | undefined): string {
  return (s ?? '').trim().toUpperCase();
}

async function coberturaMinima(): Promise<number> {
  // Prefere parâmetro do banco (configurável via UI). Fallback pro env.
  try {
    const r = await query<{ cobertura: number | string | null }>(
      `SELECT cobertura_minima_entrevista AS cobertura
         FROM people.parametros_rh
        ORDER BY id DESC LIMIT 1`
    );
    const v = r.rows[0]?.cobertura;
    if (v != null) {
      const n = Number(v);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) return n;
    }
  } catch {
    // ignora — cai pro env/default
  }
  const raw = process.env.ENTREVISTA_COBERTURA_MINIMA;
  if (!raw) return 50;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 100) return 50;
  return n;
}

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const hoje = hojeISO();
      const de = parseDateOrDefault(searchParams.get('de'), hoje);
      const ate = parseDateOrDefault(searchParams.get('ate'), hoje);
      const vagaFiltro = (searchParams.get('vaga') ?? '').trim();
      const ufFiltro = (searchParams.get('uf') ?? '').trim().toUpperCase();
      const recrutadorFiltro = normalizarRecrutador(
        searchParams.get('recrutador')
      );

      if (de > ate) {
        return errorResponse('Parâmetro `de` deve ser <= `ate`', 400);
      }

      const coberturaMin = await coberturaMinima();

      // Função interna: roda toda a pipeline (candidatos → análise → processos)
      // pra uma janela [de, ate]. Reusada pra calcular período anterior (delta).
      async function rodarJanela(deW: string, ateW: string): Promise<{
        totais: TotaisJanela;
        candidatos: CandidatoRow[];
        cpfValido: Set<string>;
        cpfComAnalise: Set<string>;
        processosMap: Map<string, ProcessoRow>;
        ranking: ReturnType<typeof construirRanking>;
      }> {
        const { totais, candidatos, cpfValido, cpfComAnalise, processosMap, ranking } =
          await executarPipeline(deW, ateW);
        return { totais, candidatos, cpfValido, cpfComAnalise, processosMap, ranking };
      }

      function construirRanking(_porRecrutador: Map<string, RecrAgg>) {
        return Array.from(_porRecrutador.values())
          .map((a) => {
            const ent = a.entrevistados.size;
            const valid = a.entrevistasValidas.size;
            const comAnalise = a.entrevistasComAnalise.size;
            const tst = a.testesEnviados.size;
            const apr = a.aprovados.size;
            const adm = a.admitidos.size;
            return {
              recrutador: a.recrutador,
              entrevistados: ent,
              entrevistasValidas: valid,
              entrevistasComAnalise: comAnalise,
              testesEnviados: tst,
              aprovados: apr,
              admitidos: adm,
              validadePercentual:
                ent === 0 ? 0 : Math.round((valid / ent) * 1000) / 10,
              taxaTestePercentual:
                ent === 0 ? 0 : Math.round((tst / ent) * 1000) / 10,
              taxaAprovacaoPercentual:
                tst === 0 ? 0 : Math.round((apr / tst) * 1000) / 10,
            };
          })
          .sort((a, b) => {
            if (b.entrevistasValidas !== a.entrevistasValidas)
              return b.entrevistasValidas - a.entrevistasValidas;
            if (b.testesEnviados !== a.testesEnviados)
              return b.testesEnviados - a.testesEnviados;
            if (b.aprovados !== a.aprovados) return b.aprovados - a.aprovados;
            return b.entrevistados - a.entrevistados;
          });
      }

      type RecrAgg = {
        recrutador: string;
        entrevistados: Set<string>;
        entrevistasValidas: Set<string>;
        entrevistasComAnalise: Set<string>;
        testesEnviados: Set<string>;
        aprovados: Set<string>;
        admitidos: Set<string>;
      };

      async function executarPipeline(deW: string, ateW: string) {
        // 1) Candidatos
        const candFiltros: string[] = [
          "status_entrevista IS NOT NULL",
          "TRIM(status_entrevista) <> ''",
          'data_entrevista >= $1::date',
          'data_entrevista <= $2::date',
        ];
        const candParams: unknown[] = [deW, ateW];
        if (vagaFiltro) {
          candParams.push(`%${vagaFiltro}%`);
          candFiltros.push(`vaga ILIKE $${candParams.length}`);
        }
        if (ufFiltro) {
          candParams.push(ufFiltro);
          candFiltros.push(`UPPER(TRIM(uf)) = $${candParams.length}`);
        }
        if (recrutadorFiltro) {
          candParams.push(recrutadorFiltro);
          candFiltros.push(
            `UPPER(TRIM(responsavel_entrevista)) = $${candParams.length}`,
          );
        }
        const candWhere = candFiltros.join(' AND ');

        const candResult = await queryRecrutamento<CandidatoRow>(
          `SELECT
             id,
             regexp_replace(cpf, '\\D', '', 'g') AS cpf_norm,
             vaga,
             uf,
             responsavel_entrevista,
             status_entrevista,
             data_entrevista
           FROM public.candidatos
           WHERE cpf IS NOT NULL AND TRIM(cpf) <> ''
             AND ${candWhere}`,
          candParams,
        );
        const candidatos = candResult.rows.filter(
          (c) => c.cpf_norm && c.cpf_norm.length > 0,
        );
        const cpfsEntrevistados = Array.from(
          new Set(candidatos.map((c) => c.cpf_norm)),
        );
        const idsCandidatos = Array.from(
          new Set(candidatos.map((c) => c.id).filter((id) => id != null)),
        );

        // 2) Análise IA
        const cpfValido = new Set<string>();
        const cpfComAnalise = new Set<string>();
        if (idsCandidatos.length > 0) {
          const analiseResult = await queryRecrutamento<{
            id_candidatura: number;
            cobertura: string | null;
          }>(
            `SELECT DISTINCT ON (ea.id_candidatura)
               ea.id_candidatura,
               (ea.analise::jsonb -> 'correlacao_analise_cv_entrevista' ->> 'cobertura_percent') AS cobertura
             FROM public.entrevistas_agendadas ea
             WHERE ea.id_candidatura = ANY($1::int[])
               AND ea.analise IS NOT NULL
               AND TRIM(ea.analise) <> ''
             ORDER BY ea.id_candidatura, ea.id DESC`,
            [idsCandidatos],
          );
          const idToCpf = new Map<number, string>();
          for (const c of candidatos) {
            if (c.id != null && c.cpf_norm) idToCpf.set(c.id, c.cpf_norm);
          }
          for (const r of analiseResult.rows) {
            const cpf = idToCpf.get(r.id_candidatura);
            if (!cpf) continue;
            cpfComAnalise.add(cpf);
            const cob = r.cobertura == null ? NaN : parseInt(r.cobertura, 10);
            if (!Number.isNaN(cob) && cob >= coberturaMin) {
              cpfValido.add(cpf);
            }
          }
        }

        // 3) Processos
        const processosMap = new Map<string, ProcessoRow>();
        if (cpfsEntrevistados.length > 0) {
          const procResult = await query<{
            candidato_cpf_norm: string;
            caminho: string;
            status: string;
            tem_aprovado: boolean;
            criado_em: Date | null;
            atualizado_em: Date | null;
          }>(
            `SELECT
               ps.candidato_cpf_norm,
               ps.caminho,
               ps.status,
               ps.criado_em,
               ps.atualizado_em,
               EXISTS (
                 SELECT 1 FROM people.dia_teste_agendamento a
                  WHERE a.processo_seletivo_id = ps.id
                    AND a.status = 'aprovado'
               ) AS tem_aprovado
             FROM people.processo_seletivo ps
             WHERE ps.candidato_cpf_norm = ANY($1::varchar[])
               AND ps.status <> 'cancelado'`,
            [cpfsEntrevistados],
          );
          for (const r of procResult.rows) {
            processosMap.set(r.candidato_cpf_norm, {
              cpf_norm: r.candidato_cpf_norm,
              caminho: r.caminho,
              status: r.status,
              tem_aprovado: r.tem_aprovado,
              criado_em: r.criado_em,
              atualizado_em: r.atualizado_em,
            });
          }
        }

        // 4) Agregar
        const cpfsUnicos = new Set<string>();
        const cpfsTeste = new Set<string>();
        const cpfsAprovados = new Set<string>();
        const cpfsAdmitidos = new Set<string>();

        const porRecrutador = new Map<string, RecrAgg>();
        function getAgg(nome: string): RecrAgg {
          let a = porRecrutador.get(nome);
          if (!a) {
            a = {
              recrutador: nome,
              entrevistados: new Set(),
              entrevistasValidas: new Set(),
              entrevistasComAnalise: new Set(),
              testesEnviados: new Set(),
              aprovados: new Set(),
              admitidos: new Set(),
            };
            porRecrutador.set(nome, a);
          }
          return a;
        }

        for (const c of candidatos) {
          cpfsUnicos.add(c.cpf_norm);
          const recr =
            normalizarRecrutador(c.responsavel_entrevista) || '(SEM RECRUTADOR)';
          const agg = getAgg(recr);
          agg.entrevistados.add(c.cpf_norm);
          if (cpfComAnalise.has(c.cpf_norm)) agg.entrevistasComAnalise.add(c.cpf_norm);
          if (cpfValido.has(c.cpf_norm)) agg.entrevistasValidas.add(c.cpf_norm);
          const proc = processosMap.get(c.cpf_norm);
          if (proc && proc.caminho === 'dia_teste') {
            cpfsTeste.add(c.cpf_norm);
            agg.testesEnviados.add(c.cpf_norm);
            if (proc.tem_aprovado) {
              cpfsAprovados.add(c.cpf_norm);
              agg.aprovados.add(c.cpf_norm);
            }
            if (proc.status === 'admitido') {
              cpfsAdmitidos.add(c.cpf_norm);
              agg.admitidos.add(c.cpf_norm);
            }
          }
        }

        const totais: TotaisJanela = {
          entrevistados: cpfsUnicos.size,
          entrevistasValidas: cpfValido.size,
          entrevistasComAnalise: cpfComAnalise.size,
          testesEnviados: cpfsTeste.size,
          aprovados: cpfsAprovados.size,
          admitidos: cpfsAdmitidos.size,
        };

        return {
          totais,
          candidatos,
          cpfValido,
          cpfComAnalise,
          processosMap,
          ranking: construirRanking(porRecrutador),
        };
      }

      // ── Pipeline atual + período anterior (em paralelo) ──
      const periodoAnt = calcularPeriodoAnterior(de, ate);
      const [resAtual, resAnterior] = await Promise.all([
        rodarJanela(de, ate),
        rodarJanela(periodoAnt.de, periodoAnt.ate),
      ]);
      const { totais, candidatos, processosMap, ranking } = resAtual;

      // ── Série diária (atual) ──
      // Distribui entrevistados/testes/aprovados/admitidos por data_entrevista.
      // testesEnviados/aprovados/admitidos só contam quando o processo realmente
      // existe pra aquele candidato — simples passthrough da data da entrevista.
      const seriePorDia = new Map<
        string,
        { data: string; entrevistados: number; testes: number; aprovados: number; admitidos: number }
      >();
      function bucket(d: string) {
        let b = seriePorDia.get(d);
        if (!b) {
          b = { data: d, entrevistados: 0, testes: 0, aprovados: 0, admitidos: 0 };
          seriePorDia.set(d, b);
        }
        return b;
      }
      // Garante todos os dias do range presentes (mesmo zerados).
      {
        const dStart = new Date(`${de}T00:00:00Z`);
        const dEnd = new Date(`${ate}T00:00:00Z`);
        for (let t = dStart; t.getTime() <= dEnd.getTime(); ) {
          bucket(t.toISOString().slice(0, 10));
          t = new Date(t.getTime() + 24 * 60 * 60 * 1000);
        }
      }
      for (const c of candidatos) {
        if (!c.data_entrevista) continue;
        const d = new Date(c.data_entrevista).toISOString().slice(0, 10);
        const b = bucket(d);
        b.entrevistados += 1;
        const proc = processosMap.get(c.cpf_norm);
        if (proc && proc.caminho === 'dia_teste') {
          b.testes += 1;
          if (proc.tem_aprovado) b.aprovados += 1;
          if (proc.status === 'admitido') b.admitidos += 1;
        }
      }
      const serie = Array.from(seriePorDia.values()).sort((a, b) =>
        a.data.localeCompare(b.data),
      );

      // ── Tempos médios entre etapas (em horas) ──
      // Entrevista → Teste: data_entrevista → processo_seletivo.criado_em
      // Teste → Aprovação: criado_em (proc) → atualizado_em (proc) quando
      //   tem_aprovado=true. Aproximação: dia_teste_agendamento.decidido_em
      //   ficaria mais preciso, mas exigiria query extra.
      // Aprovação → Admissão: criado_em → atualizado_em quando status='admitido'.
      let somaEntrTeste = 0, nEntrTeste = 0;
      let somaTesteAprov = 0, nTesteAprov = 0;
      let somaAprovAdm = 0, nAprovAdm = 0;
      const cpfPrimeiraEntrevista = new Map<string, Date>();
      for (const c of candidatos) {
        if (!c.data_entrevista) continue;
        const dt = new Date(c.data_entrevista);
        const exist = cpfPrimeiraEntrevista.get(c.cpf_norm);
        if (!exist || dt < exist) cpfPrimeiraEntrevista.set(c.cpf_norm, dt);
      }
      for (const [cpf, dataEntr] of cpfPrimeiraEntrevista) {
        const proc = processosMap.get(cpf);
        if (!proc || proc.caminho !== 'dia_teste') continue;
        const criado = proc.criado_em ? new Date(proc.criado_em) : null;
        const atualizado = proc.atualizado_em ? new Date(proc.atualizado_em) : null;
        if (criado && criado.getTime() >= dataEntr.getTime()) {
          somaEntrTeste += (criado.getTime() - dataEntr.getTime()) / 3_600_000;
          nEntrTeste += 1;
        }
        if (proc.tem_aprovado && criado && atualizado && atualizado > criado) {
          somaTesteAprov += (atualizado.getTime() - criado.getTime()) / 3_600_000;
          nTesteAprov += 1;
        }
        if (proc.status === 'admitido' && criado && atualizado && atualizado > criado) {
          somaAprovAdm += (atualizado.getTime() - criado.getTime()) / 3_600_000;
          nAprovAdm += 1;
        }
      }
      const tempoMedioHoras = {
        entrevistaParaTeste:
          nEntrTeste === 0 ? null : Math.round((somaEntrTeste / nEntrTeste) * 10) / 10,
        testeParaAprovacao:
          nTesteAprov === 0 ? null : Math.round((somaTesteAprov / nTesteAprov) * 10) / 10,
        aprovacaoParaAdmissao:
          nAprovAdm === 0 ? null : Math.round((somaAprovAdm / nAprovAdm) * 10) / 10,
      };

      // ── Comparação com período anterior ──
      const comparacao = {
        periodoAnterior: periodoAnt,
        totaisAnterior: resAnterior.totais,
        deltas: {
          entrevistados: diffDeltaPct(totais.entrevistados, resAnterior.totais.entrevistados),
          entrevistasValidas: diffDeltaPct(totais.entrevistasValidas, resAnterior.totais.entrevistasValidas),
          entrevistasComAnalise: diffDeltaPct(totais.entrevistasComAnalise, resAnterior.totais.entrevistasComAnalise),
          testesEnviados: diffDeltaPct(totais.testesEnviados, resAnterior.totais.testesEnviados),
          aprovados: diffDeltaPct(totais.aprovados, resAnterior.totais.aprovados),
          admitidos: diffDeltaPct(totais.admitidos, resAnterior.totais.admitidos),
        },
      };

      return successResponse({
        periodo: { de, ate },
        filtros: {
          vaga: vagaFiltro || null,
          uf: ufFiltro || null,
          recrutador: recrutadorFiltro || null,
        },
        criterios: { coberturaMinima: coberturaMin },
        totais,
        ranking,
        serie,
        tempoMedioHoras,
        comparacao,
      });
    } catch (error) {
      console.error('[recrutamento/relatorio-performance] erro:', error);
      return serverErrorResponse('Erro ao gerar relatório de performance');
    }
  });
}
