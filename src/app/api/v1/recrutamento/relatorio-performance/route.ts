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

      // ── 1) Candidatos entrevistados no período (banco recrutamento) ──
      const candFiltros: string[] = [
        "status_entrevista IS NOT NULL",
        "TRIM(status_entrevista) <> ''",
        'data_entrevista >= $1::date',
        'data_entrevista <= $2::date',
      ];
      const candParams: unknown[] = [de, ate];

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
          `UPPER(TRIM(responsavel_entrevista)) = $${candParams.length}`
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
        candParams
      );

      const candidatos = candResult.rows.filter(
        (c) => c.cpf_norm && c.cpf_norm.length > 0
      );

      const cpfsEntrevistados = Array.from(
        new Set(candidatos.map((c) => c.cpf_norm))
      );
      const idsCandidatos = Array.from(
        new Set(candidatos.map((c) => c.id).filter((id) => id != null))
      );

      // ── 2) Análise IA por candidato (banco recrutamento) ──
      // entrevistas_agendadas tem a análise da IA. Cobertura está em
      // analise.correlacao_analise_cv_entrevista.cobertura_percent.
      // Pega o registro mais recente por id_candidatura.
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
          [idsCandidatos]
        );

        // Mapa id_candidatura → cpf_norm
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

      // ── 3) Processos seletivos cruzados por CPF (banco People) ──
      const processosMap = new Map<string, ProcessoRow>();
      if (cpfsEntrevistados.length > 0) {
        const procResult = await query<{
          candidato_cpf_norm: string;
          caminho: string;
          status: string;
          tem_aprovado: boolean;
        }>(
          `SELECT
             ps.candidato_cpf_norm,
             ps.caminho,
             ps.status,
             EXISTS (
               SELECT 1 FROM people.dia_teste_agendamento a
                WHERE a.processo_seletivo_id = ps.id
                  AND a.status = 'aprovado'
             ) AS tem_aprovado
           FROM people.processo_seletivo ps
           WHERE ps.candidato_cpf_norm = ANY($1::varchar[])
             AND ps.status <> 'cancelado'`,
          [cpfsEntrevistados]
        );
        for (const r of procResult.rows) {
          processosMap.set(r.candidato_cpf_norm, {
            cpf_norm: r.candidato_cpf_norm,
            caminho: r.caminho,
            status: r.status,
            tem_aprovado: r.tem_aprovado,
          });
        }
      }

      // ── 4) Agregar totais ──
      const cpfsUnicos = new Set<string>();
      const cpfsTeste = new Set<string>();
      const cpfsAprovados = new Set<string>();
      const cpfsAdmitidos = new Set<string>();

      type RecrAgg = {
        recrutador: string;
        entrevistados: Set<string>;
        entrevistasValidas: Set<string>;
        entrevistasComAnalise: Set<string>;
        testesEnviados: Set<string>;
        aprovados: Set<string>;
        admitidos: Set<string>;
      };
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
        const recr = normalizarRecrutador(c.responsavel_entrevista) || '(SEM RECRUTADOR)';
        const agg = getAgg(recr);
        agg.entrevistados.add(c.cpf_norm);

        if (cpfComAnalise.has(c.cpf_norm)) {
          agg.entrevistasComAnalise.add(c.cpf_norm);
        }
        if (cpfValido.has(c.cpf_norm)) {
          agg.entrevistasValidas.add(c.cpf_norm);
        }

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

      const totais = {
        entrevistados: cpfsUnicos.size,
        entrevistasValidas: cpfValido.size,
        entrevistasComAnalise: cpfComAnalise.size,
        testesEnviados: cpfsTeste.size,
        aprovados: cpfsAprovados.size,
        admitidos: cpfsAdmitidos.size,
      };

      const ranking = Array.from(porRecrutador.values())
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
            // Validade: % das entrevistas que passaram no critério IA
            validadePercentual:
              ent === 0 ? 0 : Math.round((valid / ent) * 1000) / 10,
            taxaTestePercentual:
              ent === 0 ? 0 : Math.round((tst / ent) * 1000) / 10,
            taxaAprovacaoPercentual:
              tst === 0 ? 0 : Math.round((apr / tst) * 1000) / 10,
          };
        })
        .sort((a, b) => {
          // Ordena por entrevistas válidas (qualidade), depois testes, aprovados.
          if (b.entrevistasValidas !== a.entrevistasValidas)
            return b.entrevistasValidas - a.entrevistasValidas;
          if (b.testesEnviados !== a.testesEnviados)
            return b.testesEnviados - a.testesEnviados;
          if (b.aprovados !== a.aprovados) return b.aprovados - a.aprovados;
          return b.entrevistados - a.entrevistados;
        });

      return successResponse({
        periodo: { de, ate },
        filtros: {
          vaga: vagaFiltro || null,
          uf: ufFiltro || null,
          recrutador: recrutadorFiltro || null,
        },
        criterios: {
          coberturaMinima: coberturaMin,
        },
        totais,
        ranking,
      });
    } catch (error) {
      console.error('[recrutamento/relatorio-performance] erro:', error);
      return serverErrorResponse('Erro ao gerar relatório de performance');
    }
  });
}
