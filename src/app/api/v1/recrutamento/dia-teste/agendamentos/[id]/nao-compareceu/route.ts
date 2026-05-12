import { NextRequest } from 'next/server';
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
import { cancelarDocumentoSignProof } from '@/lib/recrutamento-dia-teste';
import {
  loadAgendamento,
  buildAgendamentoPayload,
  avancarProcessoAposDecisao,
  calcularAtrasoMarcacaoMinutos,
  invalidarCacheAgendamentosDiaTeste,
  verificarEscopoGestorAgendamento,
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

      if (ag.status !== 'agendado') {
        return errorResponse(
          `Agendamento está em status "${ag.status}" — só agendamentos pendentes podem ser marcados como ausência`,
          409,
        );
      }

      // Atraso de marcação relativo ao prazo global — vira indicador.
      const atrasoMinutos = await calcularAtrasoMarcacaoMinutos(ag.data);

      await query(
        `UPDATE people.dia_teste_agendamento
            SET status = 'nao_compareceu',
                gestor_id = COALESCE(gestor_id, $1),
                decidido_por = $1,
                decidido_em = NOW(),
                marcacao_atraso_minutos = $2,
                atualizado_em = NOW()
          WHERE id = $3::bigint`,
        [user.userId, atrasoMinutos, id],
      );

      // Encerra o processo seletivo (não compareceu = não vira colaborador).
      await avancarProcessoAposDecisao(ag.processo_seletivo_id, 'nao_compareceu', id);

      // Invalida cache do GET /agendamentos pra todos os gestors (incluindo o
      // que acabou de agir) — sem isso o próximo _carregar() do mobile devolve
      // a lista stale do Redis e o gestor vê o agendamento ainda como
      // 'agendado', tenta de novo e leva 409.
      await invalidarCacheAgendamentosDiaTeste();

      // Cancela o contrato no SignProof — sem isso o candidato continua
      // recebendo lembrete de assinatura mesmo sem ter comparecido.
      // Best-effort: falha não desfaz o "não compareceu".
      let signProofCancelado: boolean | null = null;
      let signProofErro: string | null = null;
      if (ag.documento_assinatura_id) {
        const r = await cancelarDocumentoSignProof(ag.documento_assinatura_id);
        signProofCancelado = r.ok;
        signProofErro = r.ok ? null : r.erro ?? 'desconhecido';
        if (!r.ok) {
          console.warn(
            `[recrutamento/dia-teste/agendamentos/:id/nao-compareceu] SignProof cancel falhou para doc ${ag.documento_assinatura_id}:`,
            r.erro,
          );
        }
      }

      const updated = await loadAgendamento(id);
      if (!updated) return serverErrorResponse('Estado inconsistente após update');

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Candidato marcado como AUSENTE no dia de teste #${id}${atrasoMinutos != null && atrasoMinutos > 0 ? ` (atraso de ${atrasoMinutos} min)` : ''}`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            documentoAssinaturaId: ag.documento_assinatura_id,
            signProofCancelado,
            signProofErro,
            marcacaoAtrasoMinutos: atrasoMinutos,
          },
        }),
      );

      const payload = await buildAgendamentoPayload(updated);
      // Mobile usa `marcacaoAtrasoMinutos` pra modal de aviso (>0). Ver
      // compareceu/route.ts pra mesma semântica.
      return successResponse({
        ...(payload as Record<string, unknown>),
        marcacaoAtrasoMinutos: atrasoMinutos,
      });
    } catch (error) {
      console.error(
        '[recrutamento/dia-teste/agendamentos/:id/nao-compareceu] erro:',
        error,
      );
      return serverErrorResponse('Erro ao marcar ausência');
    }
  });
}
