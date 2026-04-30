import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';

// GET /api/v1/recrutamento/metricas?de=YYYY-MM-DD&ate=YYYY-MM-DD
//
// Métricas do funil de recrutamento. Filtra processos abertos no
// período (default: últimos 30 dias). Devolve:
//   - funil de status atual + split por caminho
//   - decisões dos dias de teste (aprovado/reprovado/etc) + taxa de aprovação
//   - top 5 motivos de cancelamento

interface MetricasRow<T> {
  count: string;
  group: T;
}

function parseDateOrDefault(s: string | null, fallback: Date): string {
  if (!s) return fallback.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback.toISOString().slice(0, 10);
  return s;
}

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const hoje = new Date();
      const trintaDias = new Date(hoje.getTime() - 30 * 24 * 60 * 60 * 1000);
      const de = parseDateOrDefault(searchParams.get('de'), trintaDias);
      const ate = parseDateOrDefault(searchParams.get('ate'), hoje);

      if (de > ate) {
        return errorResponse('Parâmetro `de` deve ser <= `ate`', 400);
      }

      // ── 1) Funil por status atual (filtrando processos do período) ──
      const statusRes = await query<MetricasRow<string>>(
        `SELECT status AS "group", COUNT(*)::text AS count
           FROM people.processo_seletivo
          WHERE criado_em::date >= $1::date AND criado_em::date <= $2::date
          GROUP BY status`,
        [de, ate]
      );
      const porStatus: Record<string, number> = {
        aberto: 0,
        dia_teste: 0,
        pre_admissao: 0,
        admitido: 0,
        cancelado: 0,
      };
      for (const r of statusRes.rows) {
        porStatus[r.group] = parseInt(r.count, 10);
      }
      const totalProcessos = Object.values(porStatus).reduce((a, b) => a + b, 0);

      // ── 2) Split por caminho (A vs B) ──
      const caminhoRes = await query<MetricasRow<string>>(
        `SELECT caminho AS "group", COUNT(*)::text AS count
           FROM people.processo_seletivo
          WHERE criado_em::date >= $1::date AND criado_em::date <= $2::date
          GROUP BY caminho`,
        [de, ate]
      );
      const porCaminho = { dia_teste: 0, pre_admissao: 0 };
      for (const r of caminhoRes.rows) {
        if (r.group === 'dia_teste' || r.group === 'pre_admissao') {
          porCaminho[r.group] = parseInt(r.count, 10);
        }
      }

      // ── 3) Decisões de dia de teste (agendamentos terminais) ──
      // Filtra pelos agendamentos cuja data caiu no período. Status
      // terminais de decisão pelo gestor: aprovado, reprovado,
      // nao_compareceu, desistencia.
      const decisoesRes = await query<MetricasRow<string>>(
        `SELECT a.status AS "group", COUNT(DISTINCT ps.id)::text AS count
           FROM people.dia_teste_agendamento a
           JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
          WHERE a.data >= $1::date AND a.data <= $2::date
            AND a.status IN ('aprovado','reprovado','nao_compareceu','desistencia')
          GROUP BY a.status`,
        [de, ate]
      );
      const diaTeste = {
        aprovados: 0,
        reprovados: 0,
        naoCompareceu: 0,
        desistencia: 0,
      };
      for (const r of decisoesRes.rows) {
        switch (r.group) {
          case 'aprovado':
            diaTeste.aprovados = parseInt(r.count, 10);
            break;
          case 'reprovado':
            diaTeste.reprovados = parseInt(r.count, 10);
            break;
          case 'nao_compareceu':
            diaTeste.naoCompareceu = parseInt(r.count, 10);
            break;
          case 'desistencia':
            diaTeste.desistencia = parseInt(r.count, 10);
            break;
        }
      }
      const totalDecisoes =
        diaTeste.aprovados +
        diaTeste.reprovados +
        diaTeste.naoCompareceu +
        diaTeste.desistencia;
      const taxaAprovacao =
        totalDecisoes === 0
          ? null
          : Math.round((diaTeste.aprovados / totalDecisoes) * 1000) / 10;

      // ── 4) Top motivos de cancelamento ──
      const motivosRes = await query<{ motivo: string | null; count: string }>(
        `SELECT motivo_cancelamento AS motivo, COUNT(*)::text AS count
           FROM people.processo_seletivo
          WHERE status = 'cancelado'
            AND cancelado_em::date >= $1::date
            AND cancelado_em::date <= $2::date
          GROUP BY motivo_cancelamento
          ORDER BY count DESC
          LIMIT 5`,
        [de, ate]
      );
      const topMotivosCancelamento = motivosRes.rows.map((r) => ({
        motivo: (r.motivo ?? '').trim() === '' ? '(sem motivo informado)' : r.motivo,
        qtd: parseInt(r.count, 10),
      }));

      return successResponse({
        periodo: { de, ate },
        processos: {
          total: totalProcessos,
          porCaminho,
          porStatusAtual: porStatus,
        },
        diaTeste: {
          totalDecisoes,
          ...diaTeste,
          taxaAprovacaoPercentual: taxaAprovacao,
        },
        topMotivosCancelamento,
      });
    } catch (error) {
      console.error('[recrutamento/metricas] erro:', error);
      return serverErrorResponse('Erro ao gerar métricas');
    }
  });
}
