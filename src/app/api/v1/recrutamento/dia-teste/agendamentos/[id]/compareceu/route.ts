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
  buildAgendamentoPayload,
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/compareceu
//
// Marca o candidato como presente no dia de teste. Aceita opcionalmente
// `horarioReal` (HH:mm) — guardado como observação na auditoria, sem
// coluna dedicada.
//
// Transição válida: status 'agendado' → 'compareceu'.

const schema = z.object({
  horarioReal: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'horarioReal deve ser HH:mm')
    .optional(),
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

      if (ag.status !== 'agendado') {
        return errorResponse(
          `Agendamento já está em status "${ag.status}" — não pode marcar comparecimento`,
          409,
        );
      }

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'compareceu',
                gestor_id = COALESCE(gestor_id, $1),
                comparecimento_em = NOW(),
                atualizado_em = NOW()
          WHERE id = $2::bigint`,
        [user.userId, id],
      );

      const updated = await loadAgendamento(id);
      if (!updated) return serverErrorResponse('Estado inconsistente após update');

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato marcado como PRESENTE no dia de teste #${id}`,
          dadosNovos: {
            agendamentoId: id,
            horarioReal: parsed.data.horarioReal ?? null,
          },
        }),
      );

      const payload = await buildAgendamentoPayload(updated);
      return successResponse(payload);
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/compareceu] erro:',
        error,
      );
      return serverErrorResponse('Erro ao marcar comparecimento');
    }
  });
}
