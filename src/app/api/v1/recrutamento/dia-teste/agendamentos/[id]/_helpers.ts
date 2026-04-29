/**
 * Helpers compartilhados pelas 5 ações de agendamento de dia de teste:
 * compareceu, nao-compareceu, aprovar, reprovar, desistencia.
 *
 * Não exporta uma rota — os arquivos `route.ts` em irmãos importam daqui.
 * Nome com `_` no início mantém o Next.js de reconhecer como rota acidentalmente.
 */

import { query } from '@/lib/db';
import { queryRecrutamento } from '@/lib/db';

export interface AgendamentoRow {
  id: string;
  processo_seletivo_id: string;
  ordem: number;
  data: string; // YYYY-MM-DD
  valor_diaria: string; // numeric vem como string
  carga_horaria: number;
  status: string;
  decidido_por: string | number | null;
  // node-pg às vezes devolve TIMESTAMPTZ como string ISO; aceita os dois.
  decidido_em: Date | string | null;
  comparecimento_em: Date | string | null;
  percentual_concluido: number | null;
  valor_a_pagar: string | null;
  criado_em: Date | string;
  candidato_recrutamento_id: string | number;
  candidato_cpf_norm: string;
  vaga_snapshot: string | null;
  documento_assinatura_id: string | null;
  cargo_id: string | number | null;
  cargo_nome: string | null;
  empresa_id: string | number | null;
  empresa_nome: string | null;
  departamento_id: string | number | null;
  departamento_nome: string | null;
  processo_status: string;
}

/**
 * Coerção defensiva — node-pg parseia TIMESTAMPTZ como `Date` por
 * default, mas com type parsers customizados no projeto pode vir
 * como string ISO. Aceita os dois e devolve `Date | null`.
 */
function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Calcula quando o gestor pode tomar decisão final no dia de teste
 * (regra §3.6 do FLUXO_RECRUTAMENTO: bloqueado antes de 50% da carga
 * horária ter sido cumprida).
 *
 * Retorna `podeDecidir = false` e `podeDecidirApos = null` quando o
 * status ainda não chegou em `compareceu` (não faz sentido calcular).
 */
export function calcularPodeDecidir(row: AgendamentoRow): {
  podeDecidir: boolean;
  podeDecidirApos: Date | null;
} {
  // Status terminais: já decidido, sem nova ação.
  const statusTerminais = ['aprovado', 'reprovado', 'nao_compareceu', 'desistencia', 'cancelado'];
  if (statusTerminais.includes(row.status)) {
    return { podeDecidir: false, podeDecidirApos: null };
  }
  // Status pré-comparecimento: bloqueado, esperando o gestor marcar.
  const comparecimento = toDate(row.comparecimento_em);
  if (row.status !== 'compareceu' || comparecimento === null) {
    return { podeDecidir: false, podeDecidirApos: null };
  }
  // Calcula meio da jornada a partir do comparecimento.
  // carga_horaria é em horas; *60 = minutos; *0.5 = metade.
  const meio = new Date(
    comparecimento.getTime() + row.carga_horaria * 60 * 0.5 * 60 * 1000,
  );
  return {
    podeDecidir: Date.now() >= meio.getTime(),
    podeDecidirApos: meio,
  };
}

/**
 * Carrega o agendamento + dados de processo/cargo/empresa/departamento
 * em uma única query — base pra montar o payload de retorno no formato
 * que o mobile espera (mesmo do GET /agendamentos).
 */
export async function loadAgendamento(
  agendamentoId: string,
): Promise<AgendamentoRow | null> {
  const r = await query<AgendamentoRow>(
    `SELECT
        a.id::text                  AS id,
        a.processo_seletivo_id::text AS processo_seletivo_id,
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
        a.criado_em,
        ps.candidato_recrutamento_id,
        ps.candidato_cpf_norm,
        ps.vaga_snapshot,
        ps.documento_assinatura_id,
        ps.cargo_id,
        c.nome                      AS cargo_nome,
        ps.empresa_id,
        e.nome_fantasia             AS empresa_nome,
        ps.departamento_id,
        d.nome                      AS departamento_nome,
        ps.status                   AS processo_status
       FROM people.dia_teste_agendamento a
       JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
       LEFT JOIN people.cargos        c ON c.id = ps.cargo_id
       LEFT JOIN people.empresas      e ON e.id = ps.empresa_id
       LEFT JOIN people.departamentos d ON d.id = ps.departamento_id
      WHERE a.id = $1::bigint
      LIMIT 1`,
    [agendamentoId],
  );
  return r.rows[0] ?? null;
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

/**
 * Monta o payload do agendamento no formato que o mobile espera —
 * mesmo shape retornado pelo GET /agendamentos. Usado pelas ações
 * "compareceu" e "nao-compareceu".
 */
export async function buildAgendamentoPayload(row: AgendamentoRow) {
  // Carregar nome/telefone do candidato no banco externo de Recrutamento.
  // Best-effort: se o banco externo cair, devolve nome vazio (mobile já trata).
  const candId = toIntOrNull(row.candidato_recrutamento_id);
  let candidatoNome = '';
  let candidatoTelefone: string | null = null;
  if (candId !== null) {
    try {
      const cRes = await queryRecrutamento<{
        nome: string | null;
        telefone: string | null;
      }>(
        `SELECT nome, telefone FROM public.candidatos WHERE id = $1::int LIMIT 1`,
        [candId],
      );
      if (cRes.rows.length > 0) {
        candidatoNome = (cRes.rows[0].nome ?? '').trim();
        candidatoTelefone = cRes.rows[0].telefone
          ? cRes.rows[0].telefone.replace(/\D/g, '')
          : null;
      }
    } catch (e) {
      console.warn(
        '[recrutamento/dia-teste/agendamentos/:id] falha ao buscar candidato:',
        e,
      );
    }
  }

  const cargoId = toIntOrNull(row.cargo_id);
  const empresaId = toIntOrNull(row.empresa_id);
  const departamentoId = toIntOrNull(row.departamento_id);
  const podeDecidir = calcularPodeDecidir(row);

  return {
    agendamentoId: row.id,
    processoId: row.processo_seletivo_id,
    ordem: row.ordem,
    data: row.data,
    valorDiaria: parseFloat(row.valor_diaria),
    cargaHoraria: row.carga_horaria,
    candidato: {
      nome: candidatoNome,
      cpf: row.candidato_cpf_norm,
      telefone: candidatoTelefone,
      vagaOrigem: row.vaga_snapshot,
    },
    cargo:
      cargoId !== null ? { id: cargoId, nome: row.cargo_nome ?? '' } : null,
    empresa:
      empresaId !== null
        ? { id: empresaId, nome: row.empresa_nome ?? '' }
        : null,
    departamento:
      departamentoId !== null
        ? { id: departamentoId, nome: row.departamento_nome ?? '' }
        : null,
    status: row.status,
    podeDecidir: podeDecidir.podeDecidir,
    podeDecidirAposISO: podeDecidir.podeDecidirApos?.toISOString() ?? null,
    valorAPagarSeAprovarAgora: null,
    valorAPagarSeFinalDoExpediente: parseFloat(row.valor_diaria),
    decididoPor: row.decidido_por?.toString(),
    decididoEm: row.decidido_em,
  };
}

/**
 * Avança o processo seletivo após uma decisão final no dia de teste.
 * - Se aprovado: status do processo vai pra `pre_admissao`.
 * - Se reprovado / nao_compareceu / desistencia: processo é cancelado.
 *
 * Retorna o status novo do processo (ou null se não mudou).
 */
export async function avancarProcessoAposDecisao(
  processoId: string,
  decisao: 'aprovado' | 'reprovado' | 'desistencia' | 'nao_compareceu',
): Promise<string | null> {
  if (decisao === 'aprovado') {
    await query(
      `UPDATE people.processo_seletivo
          SET status = 'pre_admissao', atualizado_em = NOW()
        WHERE id = $1::bigint AND status = 'dia_teste'`,
      [processoId],
    );
    return 'pre_admissao';
  }
  // Demais decisões = encerramento do processo.
  await query(
    `UPDATE people.processo_seletivo
        SET status = 'cancelado',
            cancelado_em = NOW(),
            cancelado_em_etapa = 'dia_teste',
            atualizado_em = NOW()
      WHERE id = $1::bigint AND status = 'dia_teste'`,
    [processoId],
  );
  return 'cancelado';
}
