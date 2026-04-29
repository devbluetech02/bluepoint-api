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

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/reprovar
//
// Reprova o candidato após o dia de teste. Paga o valor integral da
// diária (candidato cumpriu o expediente). Implementação simplificada
// — Sprint 2.3 cobre o cálculo proporcional baseado em
// percentual_concluido. Transição: 'compareceu' → 'reprovado' (terminal).
// Encerra o processo seletivo (cancelado).

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

      if (ag.status !== 'compareceu') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — só pode reprovar candidatos que compareceram`,
          409,
        );
      }

      // Paga a diária integral (candidato cumpriu o teste).
      const valorAPagar = parseFloat(ag.valor_diaria);

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'reprovado',
                decidido_por = $1,
                decidido_em = NOW(),
                valor_a_pagar = $2,
                percentual_concluido = COALESCE(percentual_concluido, 100),
                atualizado_em = NOW()
          WHERE id = $3::bigint`,
        [user.userId, valorAPagar, id],
      );

      const proximoStatus = await avancarProcessoAposDecisao(
        ag.processo_seletivo_id,
        'reprovado',
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato REPROVADO no dia de teste #${id} (a pagar: R$ ${valorAPagar.toFixed(2)})`,
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
        status: 'reprovado',
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
        '[recrutamento/dia-teste/agendamentos/:id/reprovar] erro:',
        error,
      );
      return serverErrorResponse('Erro ao reprovar candidato');
    }
  });
}
