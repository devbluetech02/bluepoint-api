import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryRecrutamento, queryRecrutamentoWrite } from '@/lib/db';
import { criarOuReaproveitarProvisorio } from '@/lib/usuarios-provisorios';
import { validarTokenReferencias } from '@/lib/referencias-token';
import { registrarAuditoria } from '@/lib/audit';

// Endpoint PÚBLICO (sem auth) — candidato preenche referências via form web
// usando link assinado enviado por WhatsApp.
//
// GET  /api/v1/public/dia-teste-referencias?token=...
//   Retorna metadados pra a página: nome do candidato, vaga, quantas
//   referências já foram coletadas. Usado pra renderizar o form.
//
// POST /api/v1/public/dia-teste-referencias
//   Body: { token, referencias: [{nome, cargo?, empresa?, telefone}, ...] }
//   Grava 2 referências, cria provisório+solicitação e move processo
//   pra pre_admissao — exatamente como o /agendamentos/:id/referencias
//   admin, mas autenticado pelo token assinado em vez de JWT do RH.

const referenciaSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  telefone: z.string().trim().min(8).max(20),
  cargo: z.string().trim().max(120).optional(),
  empresa: z.string().trim().max(120).optional(),
});

const postSchema = z.object({
  token: z.string().min(10),
  referencias: z.array(referenciaSchema).length(2, 'Informe exatamente 2 referências'),
});

function jsonResponse(data: object, status = 200) {
  return NextResponse.json(data, { status });
}

function composeDescricao(args: { cargo?: string; empresa?: string }): string | null {
  const c = args.cargo?.trim();
  const e = args.empresa?.trim();
  if (c && e) return `${c} @ ${e}`;
  if (c) return c;
  if (e) return e;
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) return jsonResponse({ success: false, error: 'token ausente' }, 400);

    const claim = validarTokenReferencias(token);
    if (!claim) return jsonResponse({ success: false, error: 'Link inválido ou expirado' }, 401);

    // Busca processo + agendamento + nome do candidato pra montar a página
    const proc = await query<{
      processo_status: string;
      cargo_nome: string | null;
      empresa_nome: string | null;
    }>(
      `SELECT ps.status              AS processo_status,
              c.nome                 AS cargo_nome,
              e.nome_fantasia        AS empresa_nome
         FROM people.dia_teste_agendamento a
         JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
         LEFT JOIN people.cargos    c ON c.id = ps.cargo_id
         LEFT JOIN people.empresas  e ON e.id = ps.empresa_id
        WHERE a.id = $1::bigint
        LIMIT 1`,
      [claim.agendamentoId],
    );
    const p = proc.rows[0];
    if (!p) return jsonResponse({ success: false, error: 'Agendamento não encontrado' }, 404);

    let nome = '';
    try {
      const r = await queryRecrutamento<{ nome: string | null }>(
        `SELECT nome FROM public.candidatos WHERE id = $1 LIMIT 1`,
        [claim.candidatoRecrutamentoId],
      );
      nome = (r.rows[0]?.nome ?? '').trim();
    } catch { /* best-effort */ }

    return jsonResponse({
      success: true,
      data: {
        candidatoNome: nome,
        cargoNome: p.cargo_nome,
        empresaNome: p.empresa_nome,
        processoStatus: p.processo_status,
        // Quando processo já avançou, form fica em modo somente leitura.
        jaConfirmado: p.processo_status !== 'coletar_referencias',
      },
    });
  } catch (e) {
    console.error('[public/dia-teste-referencias GET] erro:', e);
    return jsonResponse({ success: false, error: 'Erro interno' }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ success: false, error: parsed.error.issues[0].message }, 400);
    }

    const claim = validarTokenReferencias(parsed.data.token);
    if (!claim) {
      return jsonResponse({ success: false, error: 'Link inválido ou expirado' }, 401);
    }

    // Carrega agendamento + processo (não usa loadAgendamento pra evitar
    // dependência do helper aqui — endpoint público fica auto-contido)
    const procRes = await query<{
      id: string;
      processo_seletivo_id: string;
      processo_status: string;
      candidato_cpf_norm: string;
      candidato_recrutamento_id: string | number;
      empresa_id: number;
      cargo_id: number;
      departamento_id: number;
      jornada_id: number;
    }>(
      `SELECT a.id::text,
              a.processo_seletivo_id::text,
              ps.status                       AS processo_status,
              ps.candidato_cpf_norm,
              ps.candidato_recrutamento_id,
              ps.empresa_id, ps.cargo_id, ps.departamento_id, ps.jornada_id
         FROM people.dia_teste_agendamento a
         JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
        WHERE a.id = $1::bigint
        LIMIT 1`,
      [claim.agendamentoId],
    );
    const ag = procRes.rows[0];
    if (!ag) return jsonResponse({ success: false, error: 'Agendamento não encontrado' }, 404);

    // Defesa: o token deve apontar pra mesmo CPF/recrutamentoId atual.
    if (
      ag.candidato_cpf_norm !== claim.candidatoCpf ||
      Number(ag.candidato_recrutamento_id) !== claim.candidatoRecrutamentoId
    ) {
      return jsonResponse({ success: false, error: 'Token inválido para este candidato' }, 401);
    }

    if (ag.processo_status !== 'coletar_referencias') {
      return jsonResponse({
        success: false,
        error: 'Suas referências já foram registradas. Obrigado!',
        code: 'ja_confirmado',
      }, 409);
    }

    const [ref1, ref2] = parsed.data.referencias;

    // 1. Grava no banco Recrutamento
    try {
      await queryRecrutamentoWrite(
        `UPDATE public.candidatos
            SET nome_referencia       = $2,
                telefone_referencia   = $3,
                descricao_referencia  = $4,
                status_referencia     = 'coletada',
                nome_referencia_2     = $5,
                telefone_referencia_2 = $6,
                descricao_referencia_2 = $7,
                status_referencia_2   = 'coletada'
          WHERE id = $1::int`,
        [
          claim.candidatoRecrutamentoId,
          ref1.nome,
          ref1.telefone.replace(/\D/g, ''),
          composeDescricao(ref1),
          ref2.nome,
          ref2.telefone.replace(/\D/g, ''),
          composeDescricao(ref2),
        ],
      );
    } catch (e) {
      console.error('[public/dia-teste-referencias] falha ao gravar referências:', e);
      return jsonResponse({ success: false, error: 'Erro ao gravar suas referências. Tente novamente.' }, 500);
    }

    // 2. Cria provisório + solicitação
    let nomeCandidato = `Candidato ${ag.candidato_cpf_norm}`;
    try {
      const nRes = await queryRecrutamento<{ nome: string | null }>(
        `SELECT nome FROM public.candidatos WHERE id = $1 LIMIT 1`,
        [claim.candidatoRecrutamentoId],
      );
      const n = nRes.rows[0]?.nome?.trim();
      if (n) nomeCandidato = n;
    } catch { /* noop */ }

    // userId fictício pra audit (form público — não há gestor logado).
    // criarOuReaproveitarProvisorio usa esse id como `criado_por`. Usamos
    // 1 (admin) como fallback documentado.
    const SYSTEM_USER_ID = 1;

    const resProv = await criarOuReaproveitarProvisorio(
      {
        nome: nomeCandidato,
        cpf: ag.candidato_cpf_norm,
        empresaId: Number(ag.empresa_id),
        cargoId: Number(ag.cargo_id),
        departamentoId: Number(ag.departamento_id),
        jornadaId: Number(ag.jornada_id),
        diasTeste: null,
      },
      SYSTEM_USER_ID,
    );

    if (!resProv.ok) {
      console.error('[public/dia-teste-referencias] falha provisório:', resProv.erro);
      return jsonResponse({
        success: false,
        error: 'Suas referências foram salvas, mas houve um problema ao prosseguir. Entre em contato com o RH.',
      }, 500);
    }

    // 3. Atualiza processo
    await query(
      `UPDATE people.processo_seletivo
          SET usuario_provisorio_id   = $1,
              solicitacao_admissao_id = $2::uuid,
              status                  = 'pre_admissao',
              atualizado_em           = NOW()
        WHERE id = $3::bigint`,
      [
        resProv.data.provRow.id,
        resProv.data.solicitacaoId,
        ag.processo_seletivo_id,
      ],
    );

    await registrarAuditoria({
      acao: 'editar',
      modulo: 'recrutamento_dia_teste',
      descricao: `Candidato ${nomeCandidato} preencheu as 2 referências via form público — processo movido para pré-admissão`,
      ip: request.headers.get('x-forwarded-for') ?? undefined,
      userAgent: request.headers.get('user-agent') ?? undefined,
      dadosNovos: {
        agendamentoId: ag.id,
        processoId: ag.processo_seletivo_id,
        canal: 'form_publico',
        referencias: [
          { nome: ref1.nome, telefone: ref1.telefone },
          { nome: ref2.nome, telefone: ref2.telefone },
        ],
      },
    });

    return jsonResponse({
      success: true,
      data: { mensagem: 'Referências recebidas. Obrigado!' },
    });
  } catch (e) {
    console.error('[public/dia-teste-referencias POST] erro:', e);
    return jsonResponse({ success: false, error: 'Erro interno' }, 500);
  }
}
