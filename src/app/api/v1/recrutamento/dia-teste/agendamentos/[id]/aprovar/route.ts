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
  calcularPodeDecidir,
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/aprovar
//
// Aprova o candidato. Não há pagamento da diária — o candidato vira
// colaborador via processo de pré-admissão. Transição: 'compareceu' →
// 'aprovado' (terminal). Avança o processo seletivo para 'pre_admissao'.

const schema = z.object({
  observacao: z.string().max(2000).optional(),
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
          `Agendamento está em status "${ag.status}" — só pode aprovar candidatos que compareceram`,
          409,
        );
      }

      // Defesa em profundidade — bloqueia aprovação antes de 50% da
      // carga horária mesmo se o cliente burlar. Mensagem traz o horário
      // exato em que o gestor poderá decidir, pra exibir na UI.
      const decisao = calcularPodeDecidir(ag);
      if (!decisao.podeDecidir) {
        const apos = decisao.podeDecidirApos
          ? decisao.podeDecidirApos.toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/Sao_Paulo',
            })
          : null;
        return errorResponse(
          apos
            ? `Aprovação só é permitida após o candidato cumprir 50% da carga horária (a partir das ${apos}).`
            : 'Aprovação ainda não é permitida — candidato precisa cumprir pelo menos 50% da carga horária do dia.',
          409,
        );
      }

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'aprovado',
                decidido_por = $1,
                decidido_em = NOW(),
                valor_a_pagar = NULL,
                atualizado_em = NOW()
          WHERE id = $2::bigint`,
        [user.userId, id],
      );

      const proximoStatus = await avancarProcessoAposDecisao(
        ag.processo_seletivo_id,
        'aprovado',
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato APROVADO no dia de teste #${id}; processo segue para pré-admissão`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            observacao: parsed.data.observacao ?? null,
          },
        }),
      );

      // Formato esperado pelo mobile (DecisaoDiaTesteResponse): chaves
      // valorAPagar e proximoPasso indicam que é uma decisão.
      return successResponse({
        agendamentoId: id,
        status: 'aprovado',
        valorAPagar: null,
        decididoEm: new Date().toISOString(),
        proximoPasso: proximoStatus === 'pre_admissao' ? 'pre_admissao' : 'encerrado',
        processo: {
          id: ag.processo_seletivo_id,
          status: proximoStatus,
        },
      });
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/aprovar] erro:',
        error,
      );
      return serverErrorResponse('Erro ao aprovar candidato');
    }
  });
}
