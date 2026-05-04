import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { z } from 'zod';
import {
  iniciarPagamentoPix,
  cadastrarBeneficiarioPix,
  normalizarChavePix,
  tipoChaveSicoob,
  PIX_CNPJ_DEFAULT,
} from '@/lib/pix-pagamentos';

// Body opcional — usado como fallback quando o candidato não tem chave
// PIX cadastrada no banco de Recrutamento. Mobile recebe 422 com code
// 'chave_pix_obrigatoria' e re-chama com esses campos preenchidos.
const bodySchema = z.object({
  chavePix: z.string().trim().min(1).max(150).optional(),
  tipoChave: z.string().trim().min(1).max(20).optional(),
  nomeBeneficiario: z.string().trim().min(1).max(200).optional(),
}).partial();

// Heurística: detecta tipo de chave PIX por formato.
// Sicoob aceita: cpf, cnpj, email, telefone, aleatoria.
function detectarTipoChave(chave: string): string {
  const t = chave.trim();
  if (/^\S+@\S+\.\S+$/.test(t)) return 'email';
  const digits = t.replace(/\D/g, '');
  if (digits.length === 11 && !t.startsWith('+')) return 'cpf';
  if (digits.length === 14) return 'cnpj';
  if (digits.length === 13 && t.startsWith('+55')) return 'telefone';
  if (digits.length === 11 && t.startsWith('+')) return 'telefone';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return 'aleatoria';
  }
  return 'aleatoria';
}

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/pagamento/preview
//
// Passo 1 do fluxo de pagamento: gestor pediu pra pagar candidato.
// Backend:
//   1. Confere agendamento — precisa ter valor_a_pagar > 0 e estar em
//      status terminal pago (aprovado/reprovado/desistencia).
//   2. Confere se ja existe pagamento_pix vivo (iniciado/enviado/sucesso) —
//      se sim, devolve o existente (idempotente).
//   3. Resolve chave_pix do candidato no banco de Recrutamento.
//   4. Chama API.iniciar -> recebe endToEndId + dados beneficiario.
//   5. Persiste registro 'iniciado' com snapshot do destino.
//   6. Devolve preview { endToEndId, valor, destino } pra UI exibir
//      antes do gestor confirmar o debito.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;

      // Override opcional do gestor — usado quando candidato não tem
      // chave PIX persistida (legado, antes do snapshot no processo).
      const rawBody = await req.json().catch(() => ({}));
      const overrideParsed = bodySchema.safeParse(rawBody);
      const overrideChave = overrideParsed.success
        ? overrideParsed.data.chavePix?.trim()
        : undefined;
      const overrideTipo = overrideParsed.success
        ? overrideParsed.data.tipoChave?.trim().toLowerCase()
        : undefined;
      const overrideNome = overrideParsed.success
        ? overrideParsed.data.nomeBeneficiario?.trim()
        : undefined;

      // 1. Carrega agendamento + processo + empresa pra pegar CNPJ pagador.
      const agRes = await query<{
        id: string;
        status: string;
        valor_a_pagar: string | null;
        candidato_recrutamento_id: string | number;
        candidato_cpf_norm: string;
        empresa_id: number | null;
        empresa_cnpj: string | null;
        candidato_nome: string | null;
        ps_pix_chave: string | null;
        ps_pix_tipo: string | null;
        ps_pix_banco: string | null;
      }>(
        `SELECT
           a.id::text                  AS id,
           a.status,
           a.valor_a_pagar::text       AS valor_a_pagar,
           ps.candidato_recrutamento_id,
           ps.candidato_cpf_norm,
           ps.empresa_id,
           e.cnpj                       AS empresa_cnpj,
           col.nome                     AS candidato_nome,
           ps.pix_chave                 AS ps_pix_chave,
           ps.pix_tipo_chave            AS ps_pix_tipo,
           ps.pix_banco                 AS ps_pix_banco
          FROM people.dia_teste_agendamento a
          JOIN people.processo_seletivo ps ON ps.id = a.processo_seletivo_id
          LEFT JOIN people.empresas e ON e.id = ps.empresa_id
          LEFT JOIN people.colaboradores col ON FALSE -- placeholder, candidato vem do banco externo
         WHERE a.id = $1::bigint
         LIMIT 1`,
        [id],
      );
      const ag = agRes.rows[0];
      if (!ag) return notFoundResponse('Agendamento não encontrado');

      const valor = ag.valor_a_pagar ? parseFloat(ag.valor_a_pagar) : 0;
      if (!valor || valor <= 0) {
        return errorResponse(
          'Agendamento não tem valor a pagar (zero ou nulo).',
          409,
        );
      }
      if (!['aprovado', 'reprovado', 'desistencia'].includes(ag.status)) {
        return errorResponse(
          `Pagamento só é permitido para agendamentos terminais com decisão; status atual: "${ag.status}".`,
          409,
        );
      }

      // 2. Pagamento ja existente (vivo) -> retorna o atual em vez de duplicar.
      const existente = await query<{
        id: string;
        end_to_end_id: string | null;
        idempotency_key: string;
        status: string;
        valor: string;
        chave_pix: string;
        destino_nome: string | null;
        destino_documento: string | null;
        destino_banco_ispb: string | null;
        destino_agencia: string | null;
        destino_conta: string | null;
      }>(
        `SELECT id::text, end_to_end_id, idempotency_key, status,
                valor::text AS valor, chave_pix,
                destino_nome, destino_documento, destino_banco_ispb,
                destino_agencia, destino_conta
           FROM people.pagamento_pix
          WHERE agendamento_id = $1::bigint
            AND status IN ('iniciado','enviado','sucesso')
          ORDER BY criado_em DESC
          LIMIT 1`,
        [id],
      );
      if (existente.rows.length > 0) {
        const ex = existente.rows[0];
        return successResponse({
          pagamentoId: ex.id,
          endToEndId: ex.end_to_end_id,
          idempotencyKey: ex.idempotency_key,
          status: ex.status,
          valor: parseFloat(ex.valor),
          chavePix: ex.chave_pix,
          destino: {
            nome: ex.destino_nome,
            documento: ex.destino_documento,
            ispb: ex.destino_banco_ispb,
            agencia: ex.destino_agencia,
            conta: ex.destino_conta,
          },
          jaIniciado: true,
        });
      }

      // 3. Resolve chave PIX do candidato (banco externo de Recrutamento).
      const candId = typeof ag.candidato_recrutamento_id === 'string'
        ? parseInt(ag.candidato_recrutamento_id, 10)
        : ag.candidato_recrutamento_id;
      const candRes = await queryRecrutamento<{
        chave_pix: string | null;
        tipo_chave: string | null;
        nome: string | null;
      }>(
        `SELECT chave_pix, tipo_chave, nome
           FROM public.candidatos WHERE id = $1::int LIMIT 1`,
        [candId],
      );
      const cand = candRes.rows[0];
      // Prioridade:
      //   1. override do gestor (mobile dialog deste preview)
      //   2. snapshot persistido em processo_seletivo (modal Iniciar Processo)
      //   3. banco de Recrutamento (legado/fallback)
      const chavePix = (
        overrideChave ||
        ag.ps_pix_chave ||
        cand?.chave_pix ||
        ''
      ).trim();
      const tipoChave =
        overrideTipo ||
        (ag.ps_pix_tipo ?? '').trim().toLowerCase() ||
        (cand?.tipo_chave ?? '').trim().toLowerCase() ||
        null;
      const nomeBenef = overrideNome || cand?.nome || 'Candidato';
      if (!chavePix) {
        // Mobile usa este code pra abrir dialog "Informe a chave PIX"
        // e re-chamar /preview com chavePix no body.
        return NextResponse.json(
          {
            success: false,
            error: 'Candidato sem chave PIX cadastrada. Informe a chave manualmente pra prosseguir.',
            code: 'chave_pix_obrigatoria',
          },
          { status: 422 },
        );
      }

      // 4. Auto-cadastra beneficiario na allowlist (idempotente — 409 ok).
      // Sem isso, /iniciar retorna erro pra chaves nao-whitelisted.
      const tipoChaveDet = (tipoChave ?? '').toLowerCase() ||
          detectarTipoChave(chavePix);
      const cnpjPagadorDigitsBenef =
        (ag.empresa_cnpj ?? '').replace(/\D/g, '') || PIX_CNPJ_DEFAULT;
      const cad = await cadastrarBeneficiarioPix({
        chavePix,
        tipoChave: tipoChaveDet,
        nomeBeneficiario: nomeBenef,
        documentoBeneficiario: ag.candidato_cpf_norm || undefined,
        cnpj: cnpjPagadorDigitsBenef,
        valorMaximoCentavos: 0,
      });
      if (!cad.ok) {
        // Beneficiário falhar não bloqueia (pode já existir global ou
        // a API ter outra regra). Se o iniciar mais abaixo falhar,
        // user verá o erro real ali. Apenas loga.
        console.warn('[pagamento/preview] cadastro beneficiario falhou:', cad.erro);
      }

      // 5. Idempotency key — usado entre preview e confirmar.
      const idempotencyKey = randomUUID();

      // Cria registro 'pendente' antes da chamada externa pra ter rastro
      // mesmo se a API estourar.
      const insRes = await query<{ id: string }>(
        `INSERT INTO people.pagamento_pix (
           agendamento_id, valor, chave_pix, tipo_chave, cnpj_pagador,
           idempotency_key, status, iniciado_por, iniciado_em,
           destino_nome
         ) VALUES ($1::bigint, $2, $3, $4, $5, $6, 'pendente', $7, NOW(), $8)
         RETURNING id::text`,
        [
          id,
          valor,
          chavePix,
          tipoChave,
          (ag.empresa_cnpj ?? '').replace(/\D/g, '') || null,
          idempotencyKey,
          user.userId,
          cand?.nome ?? null,
        ],
      );
      const pagamentoId = insRes.rows[0].id;

      // 5. Chama API Sicoob iniciar.
      const cnpjPagadorDigits =
        (ag.empresa_cnpj ?? '').replace(/\D/g, '') || PIX_CNPJ_DEFAULT;
      const r = await iniciarPagamentoPix({
        chave: chavePix,
        tipoChave: tipoChaveDet, // garante normalizacao (+55, lowercase, etc)
        cnpj: cnpjPagadorDigits,
        idempotencyKey,
      });

      if (!r.ok) {
        await query(
          `UPDATE people.pagamento_pix
              SET status='falha', tentativas = tentativas + 1,
                  ultimo_erro = $1, atualizado_em = NOW()
            WHERE id = $2::bigint`,
          [r.erro.slice(0, 1000), pagamentoId],
        );
        return errorResponse(
          `Falha ao iniciar pagamento PIX: ${r.erro}`,
          r.status && r.status >= 400 && r.status < 500 ? r.status : 502,
        );
      }

      const dest = r.data.proprietario;
      await query(
        `UPDATE people.pagamento_pix
            SET status='iniciado',
                end_to_end_id = $1,
                tipo_chave = COALESCE(tipo_chave, $2),
                destino_nome = $3,
                destino_documento = $4,
                destino_banco_ispb = $5,
                destino_agencia = $6,
                destino_conta = $7,
                resposta_iniciar = $8::jsonb,
                tentativas = tentativas + 1,
                atualizado_em = NOW()
          WHERE id = $9::bigint`,
        [
          r.data.endToEndId,
          r.data.tipo ?? null,
          dest?.nome ?? null,
          dest?.cpfCnpj ?? null,
          dest?.ispb ?? null,
          dest?.agencia ?? null,
          dest?.conta ?? null,
          JSON.stringify(r.data),
          pagamentoId,
        ],
      );

      return successResponse({
        pagamentoId,
        endToEndId: r.data.endToEndId,
        idempotencyKey,
        status: 'iniciado',
        valor,
        chavePix,
        tipoChave: r.data.tipo ?? tipoChave,
        destino: {
          nome: dest?.nome ?? null,
          documento: dest?.cpfCnpj ?? null,
          ispb: dest?.ispb ?? null,
          agencia: dest?.agencia ?? null,
          conta: dest?.conta ?? null,
          tipo: dest?.tipo ?? null,
        },
        jaIniciado: false,
      });
    } catch (error) {
      console.error('[pagamento/preview] erro:', error);
      return serverErrorResponse('Erro ao preparar pagamento PIX');
    }
  });
}
