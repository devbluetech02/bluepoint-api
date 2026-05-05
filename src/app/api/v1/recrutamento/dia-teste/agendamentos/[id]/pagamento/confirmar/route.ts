import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import {
  confirmarPagamentoPix,
  formatarValorBR,
  PIX_CNPJ_DEFAULT,
} from '@/lib/pix-pagamentos';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/pagamento/confirmar
//
// Passo 2: gestor revisou destino+valor no app e clicou Confirmar.
// Backend reusa idempotency_key gravada no preview e chama API.confirmar
// pra debitar o valor da conta da empresa pagadora.
//
// Body: { pagamentoId: string, descricao?: string }

const schema = z.object({
  pagamentoId: z.string().min(1),
  descricao: z.string().max(140).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const body = await req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }

      const pagRes = await query<{
        id: string;
        agendamento_id: string;
        valor: string;
        end_to_end_id: string | null;
        idempotency_key: string;
        status: string;
        cnpj_pagador: string | null;
        destino_nome: string | null;
        chave_pix: string | null;
      }>(
        `SELECT id::text, agendamento_id::text, valor::text AS valor,
                end_to_end_id, idempotency_key, status, cnpj_pagador,
                destino_nome, chave_pix
           FROM people.pagamento_pix
          WHERE id = $1::bigint
          LIMIT 1`,
        [parsed.data.pagamentoId],
      );
      const pag = pagRes.rows[0];
      if (!pag) return notFoundResponse('Pagamento não encontrado');
      if (pag.agendamento_id !== id) {
        return errorResponse('Pagamento não pertence ao agendamento informado', 400);
      }

      if (pag.status !== 'iniciado') {
        return errorResponse(
          `Pagamento está em status "${pag.status}" — só pode confirmar quando "iniciado"`,
          409,
        );
      }
      if (!pag.end_to_end_id) {
        return errorResponse('Pagamento sem endToEndId — refaça o preview', 409);
      }

      const valor = parseFloat(pag.valor);
      const valorBR = formatarValorBR(valor);
      const descricao =
        parsed.data.descricao?.slice(0, 140) ??
        `Diária dia de teste — agendamento #${id}`;

      // Detecta repetição: já houve pagamento REALIZADO pra mesma chave+valor+cnpj
      // antes? Sicoob exige flag `repeticao: true` na confirmação dessa
      // segunda+ tentativa pra mesmo destino/valor; sem isso responde
      // EM_PROCESSAMENTO inicialmente e marca NAO_REALIZADO/REJEITADO no GET.
      const repRes = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM people.pagamento_pix
          WHERE id <> $1::bigint
            AND status = 'sucesso'
            AND chave_pix = $2
            AND valor = $3::numeric
            AND COALESCE(cnpj_pagador, '') = COALESCE($4, '')`,
        [pag.id, pag.chave_pix, pag.valor, PIX_CNPJ_DEFAULT],
      );
      const repeticao = (parseInt(repRes.rows[0].count, 10) || 0) > 0;
      console.log(
        `[pagamento/confirmar] repeticao=${repeticao} chave=${pag.chave_pix} valor=${pag.valor} pagamento=${pag.id}`
      );

      const r = await confirmarPagamentoPix({
        endToEndId: pag.end_to_end_id,
        valor: valorBR,
        descricao,
        // Sicoob aceita CHAVE (chave PIX) ou MANUAL (dados de conta).
        // Nosso fluxo sempre usa chave -> CHAVE.
        meioIniciacao: 'CHAVE',
        // Sempre debita Ethos — fluxo de dia de teste paga só dessa conta.
        cnpj: PIX_CNPJ_DEFAULT,
        idempotencyKey: pag.idempotency_key,
        repeticao,
      });

      if (!r.ok) {
        await query(
          `UPDATE people.pagamento_pix
              SET status='falha',
                  tentativas = tentativas + 1,
                  ultimo_erro = $1,
                  atualizado_em = NOW()
            WHERE id = $2::bigint`,
          [r.erro.slice(0, 1000), pag.id],
        );
        await registrarAuditoria(
          buildAuditParams(req, user, {
            acao: 'editar',
            modulo: 'recrutamento_pagamento_pix',
            descricao: `Falha ao confirmar pagamento PIX #${pag.id} (agendamento #${id}): ${r.erro.slice(0, 200)}`,
            dadosNovos: { pagamentoId: pag.id, agendamentoId: id, erro: r.erro },
          }),
        );
        return errorResponse(
          `Falha ao confirmar pagamento PIX: ${r.erro}`,
          r.status && r.status >= 400 && r.status < 500 ? r.status : 502,
        );
      }

      // Mapeamento de estado Sicoob -> status interno.
      // REALIZADO/LIQUIDADO/SUCESSO/EFETIVADO = sucesso (terminal positivo)
      // REJEITADO/NAO_REALIZADO/FALHA          = falha (terminal negativo)
      // AGENDADO/EM_PROCESSAMENTO              = enviado (intermediario)
      // Demais                                 = enviado (default, GET sincroniza)
      const estadoUpper = (r.data.estado ?? '').toUpperCase();
      const estadoFalha = ['REJEITADO', 'NAO_REALIZADO', 'FALHA', 'FAILED'].includes(estadoUpper);
      const estadoSucesso = ['REALIZADO', 'LIQUIDADO', 'SUCESSO', 'SUCCESS', 'EFETIVADO'].includes(estadoUpper);
      const statusInterno = estadoSucesso ? 'sucesso' : estadoFalha ? 'falha' : 'enviado';

      await query(
        `UPDATE people.pagamento_pix
            SET status = $1,
                resposta_confirmar = $2::jsonb,
                confirmado_por = $3,
                confirmado_em = NOW(),
                tentativas = tentativas + 1,
                ultimo_erro = $4,
                atualizado_em = NOW()
          WHERE id = $5::bigint`,
        [
          statusInterno,
          JSON.stringify(r.data),
          user.userId,
          estadoFalha ? (r.data.detalheRejeicao ?? estadoUpper).toString().slice(0, 1000) : null,
          pag.id,
        ],
      );

      // Liga o pagamento ao agendamento mesmo em caso de falha — mantém
      // rastreabilidade da tentativa e permite UI exibir motivo da rejeição.
      await query(
        `UPDATE people.dia_teste_agendamento
            SET pagamento_pix_id = $1::bigint, atualizado_em = NOW()
          WHERE id = $2::bigint`,
        [pag.id, id],
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_pagamento_pix',
          descricao: estadoFalha
            ? `Pagamento PIX REJEITADO pelo Sicoob #${pag.id} (agendamento #${id}, estado=${estadoUpper}, motivo=${r.data.detalheRejeicao ?? 'n/d'})`
            : `Pagamento PIX confirmado #${pag.id} (agendamento #${id}, R$ ${valor.toFixed(2)} → ${pag.destino_nome ?? 'beneficiário'}, e2e=${pag.end_to_end_id}, estado=${estadoUpper})`,
          dadosNovos: {
            pagamentoId: pag.id,
            agendamentoId: id,
            valor,
            endToEndId: pag.end_to_end_id,
            estado: r.data.estado,
            statusInterno,
          },
        }),
      );

      console.log(
        `[pagamento/confirmar] pagamento=${pag.id} agendamento=${id} estado=${estadoUpper} status_interno=${statusInterno} e2e=${pag.end_to_end_id}` +
        (estadoFalha ? ` motivo=${r.data.detalheRejeicao ?? 'n/d'}` : '')
      );
      if (estadoFalha) {
        console.warn(
          `[pagamento/confirmar] FALHA — response Sicoob completo (pagamento=${pag.id}): ${JSON.stringify(r.data)}`
        );
      }

      if (estadoFalha) {
        return errorResponse(
          `PIX rejeitado pelo Sicoob: ${r.data.detalheRejeicao ?? estadoUpper}`,
          422,
        );
      }

      return successResponse({
        pagamentoId: pag.id,
        endToEndId: pag.end_to_end_id,
        status: r.data.estado ?? 'enviado',
        statusInterno,
        valor,
        confirmadoEm: new Date().toISOString(),
        detalheRejeicao: r.data.detalheRejeicao ?? null,
      });
    } catch (error) {
      console.error('[pagamento/confirmar] erro:', error);
      return serverErrorResponse('Erro ao confirmar pagamento PIX');
    }
  });
}
