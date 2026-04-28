import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { successResponse, serverErrorResponse } from '@/lib/api-response';

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
  percentual_concluido: number | null;
  valor_a_pagar: string | null;
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

      if (!todos) {
        filtros.push(`ps.status NOT IN ('cancelado')`);
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
            a.percentual_concluido,
            a.valor_a_pagar::text       AS valor_a_pagar,
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
            d.nome                      AS departamento_nome
           FROM people.dia_teste_agendamento a
           JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
           LEFT JOIN people.colaboradores col_criador ON col_criador.id = ps.criado_por
           LEFT JOIN people.cargos        c ON c.id = ps.cargo_id
           LEFT JOIN people.empresas      e ON e.id = ps.empresa_id
           LEFT JOIN people.departamentos d ON d.id = ps.departamento_id
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

      const payload = result.rows.map((r) => {
        const candId = toIntOrNull(r.candidato_recrutamento_id);
        const cand = candId !== null ? candidatosMap.get(candId) : undefined;
        const cargoId = toIntOrNull(r.cargo_id);
        const empresaId = toIntOrNull(r.empresa_id);
        const departamentoId = toIntOrNull(r.departamento_id);
        return {
          id: r.id,
          processoId: r.processo_id,
          ordem: r.ordem,
          data: r.data,
          valorDiaria: parseFloat(r.valor_diaria),
          cargaHoraria: r.carga_horaria,
          status: r.status,
          decididoPor: toIntOrNull(r.decidido_por),
          decididoEm: r.decidido_em,
          percentualConcluido: r.percentual_concluido,
          valorAPagar: r.valor_a_pagar !== null ? parseFloat(r.valor_a_pagar) : null,
          criadoEm: r.criado_em,
          processoStatus: r.processo_status,
          documentoAssinaturaId: r.documento_assinatura_id,
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
        };
      });

      return successResponse(payload);
    } catch (error) {
      console.error('[recrutamento/dia-teste/agendamentos] erro:', error);
      return serverErrorResponse('Erro ao listar agendamentos');
    }
  });
}
