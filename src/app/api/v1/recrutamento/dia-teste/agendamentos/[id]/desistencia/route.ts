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
  calcularValorProporcional,
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/desistencia
//
// Candidato desistiu durante o dia de teste. Pagamento proporcional aos
// períodos cumpridos (1 dia = 2 períodos de 50%). Faixas:
//   - Saiu antes da metade da carga horária → R$ 0 (manhã incompleta)
//   - Saiu entre 50% e 100% da carga              → 50% (só manhã)
//   - Cumpriu o dia inteiro                      → 100%
// Status 'agendado' (não compareceu) sempre é R$ 0.
// Transições válidas: 'agendado' ou 'compareceu' → 'desistencia' (terminal).
// Encerra o processo seletivo.

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

      if (ag.status !== 'agendado' && ag.status !== 'compareceu') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — desistência só pode ser registrada antes da decisão final`,
          409,
        );
      }

      // Pagamento proporcional aos períodos cumpridos.
      // 'agendado' (não compareceu) cai em 0 períodos = R$ 0 porque
      // calcularPeriodosCumpridos ignora quando comparecimento_em é null.
      const { periodos, percentual, valor: valorAPagar } =
        calcularValorProporcional(ag);

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'desistencia',
                decidido_por = $1,
                decidido_em = NOW(),
                valor_a_pagar = $2,
                percentual_concluido = $3,
                observacao_decisao = $4,
                atualizado_em = NOW()
          WHERE id = $5::bigint`,
        [user.userId, valorAPagar, percentual, parsed.data.motivo ?? null, id],
      );

      const proximoStatus = await avancarProcessoAposDecisao(
        ag.processo_seletivo_id,
        'desistencia',
        id,
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `DESISTÊNCIA registrada no dia de teste #${id} (a pagar: R$ ${valorAPagar.toFixed(2)} — ${periodos} período(s))`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            periodosCumpridos: periodos,
            percentualConcluido: percentual,
            valorAPagar,
            motivo: parsed.data.motivo ?? null,
          },
        }),
      );

      return successResponse({
        agendamentoId: id,
        status: 'desistencia',
        valorAPagar,
        periodosCumpridos: periodos,
        percentualConcluido: percentual,
        decididoEm: new Date().toISOString(),
        proximoPasso: 'encerrado',
        processo: {
          id: ag.processo_seletivo_id,
          status: proximoStatus,
        },
      });
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/desistencia] erro:',
        error,
      );
      return serverErrorResponse('Erro ao registrar desistência');
    }
  });
}
