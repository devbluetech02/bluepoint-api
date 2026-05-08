/**
 * Cola o pagamento_pix do dia de teste com o lançamento na WINDOW.PCLANC
 * do Winthor. Idempotente — se a row já tem winthor_recnum, não tenta de
 * novo.
 *
 * Best-effort por padrão: erros são gravados em pagamento_pix.winthor_erro
 * pra reprocessar via cron, sem propagar pro caller. Use { throwOnError: true }
 * pra ter exceção no flow normal (gestor reverter manual).
 */
import { query, queryRecrutamento } from './db';
import { lancarPagamentoPixNoWinthor } from './winthor';

interface LancarPorPagamentoIdResult {
  ok: boolean;
  pulado?: boolean;
  motivo?: string;
  recnum?: number;
}

export async function lancarPagamentoPixWinthorPorId(
  pagamentoId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<LancarPorPagamentoIdResult> {
  // 1. Carrega pagamento + agendamento + processo + empresa
  const r = await query<{
    pag_id: string;
    status: string;
    valor: string;
    chave_pix: string | null;
    tipo_chave: string | null;
    confirmado_por: number | null;
    winthor_recnum: string | null;
    agendamento_id: string;
    candidato_recrutamento_id: string;
    candidato_cpf_norm: string;
    cargo_nome: string | null;
    empresa_id: string | null;
    empresa_nome_fantasia: string | null;
    cod_filial_winthor: number | null;
    estado: string | null;
    cidade: string | null;
  }>(
    `SELECT pp.id::text                AS pag_id,
            pp.status,
            pp.valor::text             AS valor,
            pp.chave_pix,
            pp.tipo_chave,
            pp.confirmado_por,
            pp.winthor_recnum::text    AS winthor_recnum,
            pp.agendamento_id::text    AS agendamento_id,
            ps.candidato_recrutamento_id::text AS candidato_recrutamento_id,
            ps.candidato_cpf_norm,
            c.nome                     AS cargo_nome,
            ps.empresa_id::text        AS empresa_id,
            e.nome_fantasia            AS empresa_nome_fantasia,
            e.cod_filial_winthor,
            e.estado,
            e.cidade
       FROM people.pagamento_pix pp
       JOIN people.dia_teste_agendamento a ON a.id = pp.agendamento_id
       JOIN people.processo_seletivo    ps ON ps.id = a.processo_seletivo_id
       LEFT JOIN people.cargos    c ON c.id = ps.cargo_id
       LEFT JOIN people.empresas  e ON e.id = ps.empresa_id
      WHERE pp.id = $1::bigint
      LIMIT 1`,
    [pagamentoId],
  );
  const row = r.rows[0];
  if (!row) {
    return { ok: false, pulado: true, motivo: 'pagamento_nao_encontrado' };
  }

  if (row.winthor_recnum) {
    return { ok: true, pulado: true, motivo: 'ja_lancado', recnum: Number(row.winthor_recnum) };
  }
  if (row.status !== 'sucesso') {
    return { ok: false, pulado: true, motivo: 'status_diferente_de_sucesso' };
  }
  // CODFILIAL é fixa em 17 pra dia de teste — não depende mais da empresa.
  if (!row.chave_pix || !row.tipo_chave) {
    return { ok: false, pulado: true, motivo: 'chave_pix_ausente' };
  }

  // 2. Nome do candidato (banco de Recrutamento)
  let nomeCandidato = `Candidato ${row.candidato_cpf_norm}`;
  try {
    const c = await queryRecrutamento<{ nome: string | null }>(
      `SELECT nome FROM public.candidatos WHERE id = $1 LIMIT 1`,
      [Number(row.candidato_recrutamento_id)],
    );
    const n = c.rows[0]?.nome?.trim();
    if (n) nomeCandidato = n;
  } catch (e) {
    console.warn('[winthor-pagamento] falha ao buscar nome do candidato:', e);
  }

  // 3. Login Winthor do gestor que confirmou (NOMEFUNC). Pega do
  //    colaborador que clicou em "Confirmar pagamento" — campo confirmado_por.
  //    Padrão Winthor é UPPER+SEM ESPAÇO (TAYANEPASSOS, ROBSONAREND).
  let nomeFunc = 'PEOPLEAPI';
  if (row.confirmado_por) {
    const u = await query<{ nome: string }>(
      `SELECT nome FROM people.colaboradores WHERE id = $1 LIMIT 1`,
      [row.confirmado_por],
    );
    const n = u.rows[0]?.nome;
    if (n) nomeFunc = n;
  }

  // 4. Hashtag = UF da empresa (ou cidade abreviada). Bate com padrão
  //    visto: #GO, #SP, #ES, #DF, #CTBA (curtiba abreviada).
  const hashtag = (row.estado || '').trim().toUpperCase() ||
                  (row.cidade || '').trim().slice(0, 4).toUpperCase();

  // 5. INSERT no Winthor
  try {
    const res = await lancarPagamentoPixNoWinthor({
      nomeCandidato,
      cargo: (row.cargo_nome || 'PRESTADOR DE SERVICO'),
      hashtag,
      valor: parseFloat(row.valor),
      chavePix: row.chave_pix,
      tipoChave: row.tipo_chave,
      nomeFunc,
    });

    await query(
      `UPDATE people.pagamento_pix
          SET winthor_recnum = $1::bigint,
              winthor_lancado_em = NOW(),
              winthor_erro = NULL,
              atualizado_em = NOW()
        WHERE id = $2::bigint`,
      [res.recnum, pagamentoId],
    );

    console.log(
      `[winthor] pagamento=${pagamentoId} lancado em PCLANC RECNUM=${res.recnum} ` +
      `(cc=${res.codigoCentroCusto} valor=${row.valor} cargo="${row.cargo_nome}" ` +
      `candidato="${nomeCandidato}" gestor="${nomeFunc}")`
    );
    return { ok: true, recnum: res.recnum };
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 800) ?? String(e).slice(0, 800);
    console.error(`[winthor] FALHA ao lancar pagamento=${pagamentoId}:`, e);
    await query(
      `UPDATE people.pagamento_pix
          SET winthor_erro = $1,
              atualizado_em = NOW()
        WHERE id = $2::bigint`,
      [msg, pagamentoId],
    );
    if (opts.throwOnError) throw e;
    return { ok: false, motivo: msg };
  }
}
