import { NextRequest } from 'next/server';
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
  buildAgendamentoPayload,
  avancarProcessoAposDecisao,
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/nao-compareceu
//
// Marca o candidato como ausente no dia de teste. Sem pagamento.
// Transição válida: 'agendado' → 'nao_compareceu' (terminal).
// Encerra o processo seletivo (cancelado).

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const ag = await loadAgendamento(id);
      if (!ag) return notFoundResponse('Agendamento não encontrado');

      if (ag.status !== 'agendado') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — só agendamentos pendentes podem ser marcados como ausência`,
          409,
        );
      }

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'nao_compareceu',
                gestor_id = COALESCE(gestor_id, $1),
                decidido_por = $1,
                decidido_em = NOW(),
                atualizado_em = NOW()
          WHERE id = $2::bigint`,
        [user.userId, id],
      );

      // Encerra o processo seletivo (não compareceu = não vira colaborador).
      await avancarProcessoAposDecisao(ag.processo_seletivo_id, 'nao_compareceu');

      const updated = await loadAgendamento(id);
      if (!updated) return serverErrorResponse('Estado inconsistente após update');

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato marcado como AUSENTE no dia de teste #${id}`,
          dadosNovos: { agendamentoId: id, processoId: ag.processo_seletivo_id },
        }),
      );

      const payload = await buildAgendamentoPayload(updated);
      return successResponse(payload);
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/nao-compareceu] erro:',
        error,
      );
      return serverErrorResponse('Erro ao marcar ausência');
    }
  });
}
