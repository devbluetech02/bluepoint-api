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
//   2) people.processo_seletivo no banco People (Aurora):
//      - Mandado pra teste = caminho='dia_teste' (match por CPF)
//      - Aprovado = ao menos um dia_teste_agendamento status='aprovado'
//      - Admitido = processo_seletivo.status='admitido'
//
// Default de período: hoje (00:00 → 23:59) — relatório diário.

interface CandidatoRow {
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

      // ── 2) Processos seletivos cruzados por CPF (banco People) ──
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

      // ── 3) Agregar totais ──
      const cpfsUnicos = new Set<string>();
      const cpfsTeste = new Set<string>();
      const cpfsAprovados = new Set<string>();
      const cpfsAdmitidos = new Set<string>();

      type RecrAgg = {
        recrutador: string;
        entrevistados: Set<string>;
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
        testesEnviados: cpfsTeste.size,
        aprovados: cpfsAprovados.size,
        admitidos: cpfsAdmitidos.size,
      };

      const ranking = Array.from(porRecrutador.values())
        .map((a) => {
          const ent = a.entrevistados.size;
          const tst = a.testesEnviados.size;
          const apr = a.aprovados.size;
          const adm = a.admitidos.size;
          return {
            recrutador: a.recrutador,
            entrevistados: ent,
            testesEnviados: tst,
            aprovados: apr,
            admitidos: adm,
            taxaTestePercentual:
              ent === 0 ? 0 : Math.round((tst / ent) * 1000) / 10,
            taxaAprovacaoPercentual:
              tst === 0 ? 0 : Math.round((apr / tst) * 1000) / 10,
          };
        })
        .sort((a, b) => {
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
        totais,
        ranking,
      });
    } catch (error) {
      console.error('[recrutamento/relatorio-performance] erro:', error);
      return serverErrorResponse('Erro ao gerar relatório de performance');
    }
  });
}
