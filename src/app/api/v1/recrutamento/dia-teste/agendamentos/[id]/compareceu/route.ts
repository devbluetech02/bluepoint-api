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
// Marca o candidato como presente no dia de teste.
//
// `horarioReal` (HH:mm, opcional): horário REAL de chegada do candidato.
// Quando enviado, `comparecimento_em` é gravado como (data do agendamento +
// hora informada) no fuso America/Sao_Paulo. Sem horarioReal, usa NOW()
// — só recomendado quando o gestor marca no momento da chegada.
// Validação: o gestor não pode informar horário antes de 04:00 nem
// depois de 22:00 (jornadas reais — fora disso provavelmente erro de
// digitação).
//
// Transição válida: status 'agendado' → 'compareceu'.

const schema = z.object({
  horarioReal: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'horarioReal deve ser HH:mm')
    .optional(),
});

// Constrói TIMESTAMPTZ no fuso America/Sao_Paulo a partir de
// (data YYYY-MM-DD + hora HH:mm). Usa offset fixo de Brasília (-03:00) —
// servidor está em UTC e o BR não tem horário de verão hoje.
function buildComparecimentoEmISO(
  dataAgendamento: string,
  horario: string,
): string {
  return `${dataAgendamento}T${horario}:00-03:00`;
}

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

      // Valida horarioReal (se enviado) e calcula comparecimento_em.
      // Sem horarioReal, usa NOW() (compat com clientes velhos).
      let comparecimentoEm: string | null = null;
      if (parsed.data.horarioReal) {
        const [hh, mm] = parsed.data.horarioReal.split(':').map(Number);
        if (hh < 4 || hh > 22 || mm > 59) {
          return errorResponse(
            'Horário fora da faixa de jornada (04:00–22:00). Verifique o valor digitado.',
            400,
          );
        }
        comparecimentoEm = buildComparecimentoEmISO(ag.data, parsed.data.horarioReal);
      }

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'compareceu',
                gestor_id = COALESCE(gestor_id, $1),
                comparecimento_em = COALESCE($2::timestamptz, NOW()),
                atualizado_em = NOW()
          WHERE id = $3::bigint`,
        [user.userId, comparecimentoEm, id],
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
