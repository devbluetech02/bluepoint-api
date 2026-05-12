import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import {
  loadAgendamento,
  avancarProcessoAposDecisao,
  calcularValorTotalProcesso,
  calcularPodeDecidir,
  invalidarCacheAgendamentosDiaTeste,
  verificarEscopoGestorAgendamento,
} from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/reprovar
//
// Reprova o candidato após o dia de teste. Paga proporcional aos
// períodos cumpridos (1 dia = 2 períodos de 50% cada). Como a trava
// dos 50% já bloqueia a decisão antes da manhã, o valor sempre fica
// em 50% (manhã) ou 100% (dia inteiro).
// Transição: 'compareceu' → 'reprovado' (terminal). Encerra o processo.

const schema = z.object({
  motivo: z.string().min(1, 'Motivo é obrigatório').max(2000),
  // Nota é opcional: o app mobile na versão 4.9.0+ envia, mas versões
  // anteriores reprovam sem nota. Mantemos o campo para retrocompatibilidade
  // enquanto a Play Store não distribui a build com star-rating.
  nota: z
    .number()
    .int('Nota deve ser inteiro')
    .min(1, 'Nota mínima é 1')
    .max(5, 'Nota máxima é 5')
    .optional()
    .nullable(),
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

      const escopoCheck = await verificarEscopoGestorAgendamento(user, ag);
      if (!escopoCheck.ok) {
        return forbiddenResponse(escopoCheck.motivo);
      }

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

      // Mesma trava de aprovar (FLUXO §3.6): reprovação só após 50% carga.
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
            ? `Reprovação só é permitida após o candidato cumprir 50% da carga horária (a partir das ${apos}).`
            : 'Reprovação ainda não é permitida — candidato precisa cumprir pelo menos 50% da carga horária do dia.',
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
                nota_reprovacao = $5,
                atualizado_em = NOW()
          WHERE id = $6::bigint`,
        [
          user.userId,
          total.valorAgendamentoAtual,
          total.percentualAtual,
          parsed.data.motivo,
          parsed.data.nota ?? null,
          id,
        ],
      );

      const proximoStatus = await avancarProcessoAposDecisao(
        ag.processo_seletivo_id,
        'reprovado',
        id,
      );

      // Invalida cache do GET /agendamentos — ver nao-compareceu/route.ts.
      await invalidarCacheAgendamentosDiaTeste();

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato REPROVADO no dia de teste #${id}${parsed.data.nota != null ? ` com nota ${parsed.data.nota}/5` : ' (sem nota)'} (a pagar: R$ ${total.valorTotal.toFixed(2)} = R$ ${total.valorDiasAnteriores.toFixed(2)} dias anteriores + R$ ${total.valorAgendamentoAtual.toFixed(2)} hoje)`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            periodosCumpridos: total.periodosAtual,
            percentualConcluido: total.percentualAtual,
            valorAgendamentoAtual: total.valorAgendamentoAtual,
            valorDiasAnteriores: total.valorDiasAnteriores,
            valorTotal: total.valorTotal,
            motivo: parsed.data.motivo,
            notaReprovacao: parsed.data.nota ?? null,
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
