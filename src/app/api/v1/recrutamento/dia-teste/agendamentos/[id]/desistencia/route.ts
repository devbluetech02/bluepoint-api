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
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/desistencia
//
// Candidato desistiu durante o dia de teste. Se já compareceu, paga
// proporcional ao tempo trabalhado (percentual_concluido se preenchido,
// senão valor proporcional aos dias do teste). Implementação simplificada —
// Sprint 2.3 cobre o cálculo refinado.
//
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

      if (ag.status !== 'agendado' && ag.status !== 'compareceu') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — desistência só pode ser registrada antes da decisão final`,
          409,
        );
      }

      // Pagamento proporcional: se compareceu, usa percentual_concluido
      // (default 100% se ausente); se não compareceu, sem pagamento.
      let valorAPagar: number | null = null;
      if (ag.status === 'compareceu') {
        const percentual = ag.percentual_concluido ?? 100;
        valorAPagar = (parseFloat(ag.valor_diaria) * percentual) / 100;
      }

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'desistencia',
                decidido_por = $1,
                decidido_em = NOW(),
                valor_a_pagar = $2,
                atualizado_em = NOW()
          WHERE id = $3::bigint`,
        [user.userId, valorAPagar, id],
      );

      const proximoStatus = await avancarProcessoAposDecisao(
        ag.processo_seletivo_id,
        'desistencia',
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `DESISTÊNCIA registrada no dia de teste #${id} (a pagar: ${valorAPagar !== null ? `R$ ${valorAPagar.toFixed(2)}` : 'sem pagamento'})`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            valorAPagar,
            motivo: parsed.data.motivo ?? null,
          },
        }),
      );

      return successResponse({
        agendamentoId: id,
        status: 'desistencia',
        valorAPagar,
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
