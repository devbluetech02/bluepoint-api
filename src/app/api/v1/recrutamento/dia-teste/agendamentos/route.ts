import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import {
  calcularPodeDecidir,
  calcularValorProporcional,
  type AgendamentoRow,
} from './[id]/_helpers';

// GET /api/v1/recrutamento/dia-teste/agendamentos
//
// Lista agendamentos de dia de teste com dados do processo, cargo,
// empresa, departamento e candidato (este último vem do banco externo
// de Recrutamento).
//
// Query params (todos opcionais):
//   - data       (YYYY-MM-DD)  filtra pelos agendamentos exatamente desse dia
//   - de / ate   (YYYY-MM-DD)  janela de datas (inclusive)
//   - status                   ex: agendado, compareceu, aprovado, etc.
//   - todos      (true|false)  default false. Quando false, esconde
//                              agendamentos cujo processo está cancelado
//                              ou em estado terminal (admitido).

interface Row {
  id: string;
  processo_id: string;
  ordem: number;
  data: string;
  valor_diaria: string;
  carga_horaria: number;
  status: string;
  // node-pg serializa bigint como string por default (overflow safety).
  decidido_por: string | number | null;
  decidido_em: Date | null;
  comparecimento_em: Date | null;
  percentual_concluido: number | null;
  valor_a_pagar: string | null;
  observacao_decisao: string | null;
  // Soma de valor_diaria dos dias do mesmo processo com ordem < esta
  // e status='compareceu' (cumpridos sem decisão). Usado pra calcular
  // o valor TOTAL cumulativo do processo a pagar.
  valor_dias_anteriores: string | null;
  // Quantidade de dias com ordem < esta e status='compareceu'.
  // Cada um vale 2 períodos no cálculo de "X/Y períodos cumpridos".
  dias_anteriores_compareceu_count: string | null;
  // Total de dias do processo (excluindo cancelados). × 2 = total de períodos.
  total_dias_processo: string | null;
  criado_em: Date;
  // do processo
  processo_status: string;
  candidato_recrutamento_id: string | number;
  candidato_cpf_norm: string;
  vaga_snapshot: string | null;
  documento_assinatura_id: string | null;
  criado_por: string | number | null;
  criado_por_nome: string | null;
  // joins
  cargo_id: string | number | null;
  cargo_nome: string | null;
  empresa_id: string | number | null;
  empresa_nome: string | null;
  departamento_id: string | number | null;
  departamento_nome: string | null;
  pagamento_pix_id: string | number | null;
  pagamento_pix_status: string | null;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const data = searchParams.get('data');
      const de = searchParams.get('de');
      const ate = searchParams.get('ate');
      const status = searchParams.get('status');
      const empresaId = searchParams.get('empresaId');
      const todos = searchParams.get('todos') === 'true';

      const filtros: string[] = [];
      const params: unknown[] = [];

      if (data) {
        filtros.push(`a.data = $${params.length + 1}::date`);
        params.push(data);
      } else if (de || ate) {
        if (de) {
          filtros.push(`a.data >= $${params.length + 1}::date`);
          params.push(de);
        }
        if (ate) {
          filtros.push(`a.data <= $${params.length + 1}::date`);
          params.push(ate);
        }
      }

      if (status) {
        filtros.push(`a.status = $${params.length + 1}`);
        params.push(status);
      }

      if (empresaId) {
        const eid = parseInt(empresaId, 10);
        if (!Number.isNaN(eid)) {
          filtros.push(`ps.empresa_id = $${params.length + 1}::bigint`);
          params.push(eid);
        }
      }

      // `todos=false` (default) esconde APENAS agendamentos cancelados
      // administrativamente (RH cancelando o processo). Decisões terminais
      // do gestor no dia de teste — aprovado, reprovado, nao_compareceu,
      // desistencia — devem CONTINUAR visíveis pro RH acompanhar (e pro
      // gestor ver o histórico). Antes filtrávamos `ps.status` (do processo)
      // mas isso escondia tudo, já que reprovado/desistencia/nao_compareceu
      // marcam o processo como 'cancelado' via avancarProcessoAposDecisao.
      if (!todos) {
        filtros.push(`a.status != 'cancelado'`);
      }

      const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

      const result = await query<Row>(
        `SELECT
            a.id::text                  AS id,
            a.processo_seletivo_id::text AS processo_id,
            a.ordem,
            a.data::text                AS data,
            a.valor_diaria::text        AS valor_diaria,
            a.carga_horaria,
            a.status,
            a.decidido_por,
            a.decidido_em,
            a.comparecimento_em,
            a.percentual_concluido,
            a.valor_a_pagar::text       AS valor_a_pagar,
            a.observacao_decisao,
            COALESCE((
              SELECT SUM(a2.valor_diaria)
                FROM people.dia_teste_agendamento a2
               WHERE a2.processo_seletivo_id = a.processo_seletivo_id
                 AND a2.ordem < a.ordem
                 AND a2.status = 'compareceu'
            ), 0)::text                 AS valor_dias_anteriores,
            (SELECT COUNT(*)
               FROM people.dia_teste_agendamento a3
              WHERE a3.processo_seletivo_id = a.processo_seletivo_id
                AND a3.ordem < a.ordem
                AND a3.status = 'compareceu')::text
                                        AS dias_anteriores_compareceu_count,
            (SELECT COUNT(*)
               FROM people.dia_teste_agendamento a4
              WHERE a4.processo_seletivo_id = a.processo_seletivo_id
                AND a4.status != 'cancelado')::text
                                        AS total_dias_processo,
            a.criado_em,
            ps.status                   AS processo_status,
            ps.candidato_recrutamento_id,
            ps.candidato_cpf_norm,
            ps.vaga_snapshot,
            ps.documento_assinatura_id,
            ps.criado_por,
            col_criador.nome            AS criado_por_nome,
            ps.cargo_id,
            c.nome                      AS cargo_nome,
            ps.empresa_id,
            e.nome_fantasia             AS empresa_nome,
            ps.departamento_id,
            d.nome                      AS departamento_nome,
            a.pagamento_pix_id::text    AS pagamento_pix_id,
            pix.status                  AS pagamento_pix_status
           FROM people.dia_teste_agendamento a
           JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
           LEFT JOIN people.colaboradores col_criador ON col_criador.id = ps.criado_por
           LEFT JOIN people.cargos        c ON c.id = ps.cargo_id
           LEFT JOIN people.empresas      e ON e.id = ps.empresa_id
           LEFT JOIN people.departamentos d ON d.id = ps.departamento_id
           LEFT JOIN people.pagamento_pix pix ON pix.id = a.pagamento_pix_id
           ${where}
          ORDER BY a.data ASC, a.ordem ASC, a.criado_em ASC`,
        params
      );

      // Buscar dados dos candidatos no banco externo de Recrutamento.
      // candidato_recrutamento_id é BIGINT no Postgres → vem como string.
      const candidatoIds = Array.from(
        new Set(
          result.rows
            .map((r) => toIntOrNull(r.candidato_recrutamento_id))
            .filter((v): v is number => v !== null)
        )
      );

      const candidatosMap = new Map<number, { nome: string; telefone: string | null; email: string | null; cpf: string; responsavel: string | null }>();
      if (candidatoIds.length > 0) {
        try {
          const cRes = await queryRecrutamento<{
            id: number;
            nome: string | null;
            telefone: string | null;
            email: string | null;
            cpf: string | null;
            resposavel: string | null;
          }>(
            `SELECT id, nome, telefone, email, resposavel,
                    regexp_replace(cpf, '\\D', '', 'g') AS cpf
               FROM public.candidatos
              WHERE id = ANY($1::int[])`,
            [candidatoIds]
          );
          for (const c of cRes.rows) {
            candidatosMap.set(c.id, {
              nome: (c.nome ?? '').trim(),
              telefone: c.telefone ? c.telefone.replace(/\D/g, '') : null,
              email: c.email ? c.email.trim() : null,
              cpf: c.cpf ?? '',
              responsavel: c.resposavel ? c.resposavel.trim() : null,
            });
          }
        } catch (e) {
          console.warn('[recrutamento/dia-teste/agendamentos] falha ao buscar candidatos no banco de Recrutamento:', e);
        }
      }

      // Consultar status dos contratos no SignProof (batch).
      const docIds = Array.from(new Set(
        result.rows
          .map((r) => r.documento_assinatura_id)
          .filter((v): v is string => v != null && v !== '')
      ));
      const docStatusMap = new Map<string, string>();
      if (docIds.length > 0) {
        const baseUrl = process.env.SIGNPROOF_API_URL;
        const apiKey = process.env.SIGNPROOF_API_KEY;
        if (baseUrl && apiKey) {
          try {
            const spResp = await fetch(`${baseUrl}/api/v1/integration/documents/batch-status`, {
              method: 'POST',
              headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ document_ids: docIds }),
            });
            if (spResp.ok) {
              const spData = await spResp.json() as { data?: { id?: string; status?: string }[] };
              for (const d of spData.data ?? []) {
                if (d.id && d.status) docStatusMap.set(d.id, d.status);
              }
            }
          } catch (e) {
            console.warn('[recrutamento/dia-teste/agendamentos] falha ao consultar SignProof batch-status:', e);
          }
        }
      }

      const payload = result.rows.map((r) => {
        const candId = toIntOrNull(r.candidato_recrutamento_id);
        const cand = candId !== null ? candidatosMap.get(candId) : undefined;
        const cargoId = toIntOrNull(r.cargo_id);
        const empresaId = toIntOrNull(r.empresa_id);
        const departamentoId = toIntOrNull(r.departamento_id);

        // Calcula podeDecidir/podeDecidirAposISO usando o mesmo helper
        // do _helpers.ts pra manter consistência com /aprovar e os
        // demais endpoints de decisão. Bloqueia o gestor antes de 50%
        // da carga horária ter sido cumprida desde o comparecimento.
        const rowAsAg = {
          ...r,
          processo_seletivo_id: r.processo_id,
        } as unknown as AgendamentoRow;
        const podeDecidir = calcularPodeDecidir(rowAsAg);
        // "Se decidir agora" — só faz sentido enquanto o status é
        // 'compareceu' (gestor ainda pode decidir). Em status terminais
        // ou pré-comparecimento, devolve null.
        const proporcional =
          r.status === 'compareceu'
            ? calcularValorProporcional(rowAsAg)
            : null;
        const valorDiasAnteriores = parseFloat(r.valor_dias_anteriores ?? '0');
        const valorTotalSeAprovarAgora =
          proporcional !== null
            ? Math.round((valorDiasAnteriores + proporcional.valor) * 100) / 100
            : null;
        // Períodos do processo INTEIRO (X/Y).
        // - Cada dia anterior `compareceu` vale 2 períodos.
        // - Dia atual contribui com `proporcional.periodos` (0/1/2) se ainda
        //   pode decidir; OU 2 se já passou pra terminal aprovado/reprovado/
        //   desistencia (foram contados 100% no momento da decisão).
        // - Total = 2 × dias do processo (excluindo cancelados).
        const diasAnterioresCompareceuCount = parseInt(
          r.dias_anteriores_compareceu_count ?? '0',
          10,
        ) || 0;
        const totalDiasProcesso = parseInt(r.total_dias_processo ?? '0', 10) || 0;
        const periodosTotaisProcesso = totalDiasProcesso * 2;
        const periodosAtualParaSoma =
          proporcional?.periodos ??
          (r.percentual_concluido != null
            ? Math.round((r.percentual_concluido / 50)) // 0/50/100 → 0/1/2
            : 0);
        const periodosCumpridosProcesso =
          diasAnterioresCompareceuCount * 2 + periodosAtualParaSoma;

        return {
          id: r.id,
          // Mobile espera `agendamentoId` no fromJson — devolver os dois
          // mantém compat com clientes velhos que liam só `id`.
          agendamentoId: r.id,
          processoId: r.processo_id,
          ordem: r.ordem,
          data: r.data,
          valorDiaria: parseFloat(r.valor_diaria),
          cargaHoraria: r.carga_horaria,
          status: r.status,
          decididoPor: r.decidido_por != null ? String(r.decidido_por) : null,
          observacaoDecisao: r.observacao_decisao,
          decididoEm: r.decidido_em,
          comparecimentoEm: r.comparecimento_em,
          podeDecidir: podeDecidir.podeDecidir,
          podeDecidirAposISO: podeDecidir.podeDecidirApos?.toISOString() ?? null,
          percentualConcluido: r.percentual_concluido,
          valorAPagar: r.valor_a_pagar !== null ? parseFloat(r.valor_a_pagar) : null,
          valorAPagarSeAprovarAgora: proporcional?.valor ?? null,
          periodosCumpridosAgora: proporcional?.periodos ?? null,
          valorDiasAnteriores,
          valorTotalSeAprovarAgora,
          periodosCumpridosProcesso,
          periodosTotaisProcesso,
          criadoEm: r.criado_em,
          processoStatus: r.processo_status,
          documentoAssinaturaId: r.documento_assinatura_id,
          documentoAssinaturaStatus: r.documento_assinatura_id ? (docStatusMap.get(r.documento_assinatura_id) ?? null) : null,
          vagaOrigem: r.vaga_snapshot,
          enviadoPor: {
            id: toIntOrNull(r.criado_por),
            nome: r.criado_por_nome ?? null,
          },
          candidato: {
            recrutamentoId: candId,
            cpf: r.candidato_cpf_norm,
            nome: cand?.nome ?? '',
            telefone: cand?.telefone ?? null,
            email: cand?.email ?? null,
            responsavel: cand?.responsavel ?? null,
          },
          cargo: cargoId !== null ? { id: cargoId, nome: r.cargo_nome ?? '' } : null,
          empresa: empresaId !== null ? { id: empresaId, nome: r.empresa_nome ?? '' } : null,
          departamento: departamentoId !== null
            ? { id: departamentoId, nome: r.departamento_nome ?? '' }
            : null,
          pagamentoPixId:
            r.pagamento_pix_id != null && r.pagamento_pix_id !== ''
              ? String(r.pagamento_pix_id)
              : null,
          pagamentoPixStatus: r.pagamento_pix_status ?? null,
        };
      });

      return successResponse(payload);
    } catch (error) {
      console.error('[recrutamento/dia-teste/agendamentos] erro:', error);
      return serverErrorResponse('Erro ao listar agendamentos');
    }
  });
}
