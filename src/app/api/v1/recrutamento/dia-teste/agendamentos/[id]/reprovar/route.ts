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
  loadAgendamento,
  avancarProcessoAposDecisao,
  calcularValorTotalProcesso,
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/reprovar
//
// Reprova o candidato após o dia de teste. Paga proporcional aos
// períodos cumpridos (1 dia = 2 períodos de 50% cada). Como a trava
// dos 50% já bloqueia a decisão antes da manhã, o valor sempre fica
// em 50% (manhã) ou 100% (dia inteiro).
// Transição: 'compareceu' → 'reprovado' (terminal). Encerra o processo.

const schema = z.object({
  motivo: z.string().max(2000).optional(),
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

      const ag = await loadAgendamento(id);
      if (!ag) return notFoundResponse('Agendamento não encontrado');

      if (ag.processo_status === 'cancelado') {
        return errorResponse(
          'Processo seletivo está cancelado — nenhuma ação é permitida no agendamento',
          409,
        );
      }

      if (ag.status !== 'compareceu') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — só pode reprovar candidatos que compareceram`,
          409,
        );
      }

      // Pagamento total cumulativo: dias anteriores cumpridos + período atual.
      const total = await calcularValorTotalProcesso(ag);

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'reprovado',
                decidido_por = $1,
                decidido_em = NOW(),
                valor_a_pagar = $2,
                percentual_concluido = $3,
                observacao_decisao = $4,
                atualizado_em = NOW()
          WHERE id = $5::bigint`,
        [
          user.userId,
          total.valorAgendamentoAtual,
          total.percentualAtual,
          parsed.data.motivo ?? null,
          id,
        ],
      );

      const proximoStatus = await avancarProcessoAposDecisao(
        ag.processo_seletivo_id,
        'reprovado',
        id,
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato REPROVADO no dia de teste #${id} (a pagar: R$ ${total.valorTotal.toFixed(2)} = R$ ${total.valorDiasAnteriores.toFixed(2)} dias anteriores + R$ ${total.valorAgendamentoAtual.toFixed(2)} hoje)`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            periodosCumpridos: total.periodosAtual,
            percentualConcluido: total.percentualAtual,
            valorAgendamentoAtual: total.valorAgendamentoAtual,
            valorDiasAnteriores: total.valorDiasAnteriores,
            valorTotal: total.valorTotal,
            motivo: parsed.data.motivo ?? null,
          },
        }),
      );

      return successResponse({
        agendamentoId: id,
        status: 'reprovado',
        valorAPagar: total.valorTotal,
        valorAgendamentoAtual: total.valorAgendamentoAtual,
        valorDiasAnteriores: total.valorDiasAnteriores,
        periodosCumpridos: total.periodosAtual,
        percentualConcluido: total.percentualAtual,
        decididoEm: new Date().toISOString(),
        proximoPasso: 'encerrado',
        processo: {
          id: ag.processo_seletivo_id,
          status: proximoStatus,
        },
      });
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/reprovar] erro:',
        error,
      );
      return serverErrorResponse('Erro ao reprovar candidato');
    }
  });
}
