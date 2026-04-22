import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';
import { enviarPushParaCargoNome } from '@/lib/push-colaborador';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

interface Params {
  params: Promise<{ id: string }>;
}

const solicitarCorrecaoSchema = z.object({
  campos:     z.array(z.string()).optional().default([]),
  documentos: z.array(z.number().int().positive()).optional().default([]),
  observacao: z.string().max(1000).optional().nullable(),
}).refine(
  (d) => (d.campos?.length ?? 0) > 0 || (d.documentos?.length ?? 0) > 0,
  { message: 'Informe ao menos um campo ou documento para corrigir' }
);

/**
 * POST /api/v1/admissao/solicitacoes/:id/solicitar-correcao
 * Marca a solicitação como "correcao_solicitada", armazena quais campos/documentos
 * precisam ser corrigidos e notifica o usuário provisório via push.
 *
 * Body:
 * {
 *   campos:     string[]   // IDs dos campos do formulário com problema
 *   documentos: number[]   // IDs dos tipos de documento com problema
 *   observacao: string     // Mensagem livre para o candidato (opcional)
 * }
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAdmissao(request, async (req) => {
    try {
      const { id } = await params;

      const body = await req.json().catch(() => null);
      if (!body) return errorResponse('Body inválido', 400);

      const validation = validateBody(solicitarCorrecaoSchema, body);
      if (!validation.success) {
        const firstError = Object.values(validation.errors)[0]?.[0];
        return errorResponse(firstError ?? 'Dados inválidos', 400);
      }

      const { campos, documentos, observacao } = validation.data;

      // Busca a solicitação e verifica se pode solicitar correção
      const existing = await query(
        `SELECT id, status, usuario_provisorio_id, onesignal_subscription_id
           FROM people.solicitacoes_admissao
          WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const sol = existing.rows[0];

      if (sol.status === 'admitido') {
        return errorResponse('Não é possível solicitar correção em uma solicitação já admitida', 409);
      }

      const pendencias = { campos, documentos, observacao: observacao ?? null };

      // Preserva o status em que o candidato estava — restaurado no reenvio pós-correção.
      // Se já estava em correcao_solicitada (re-correção), mantém o status_antes_correcao anterior.
      const result = await query(
        `UPDATE people.solicitacoes_admissao
            SET status                = 'correcao_solicitada',
                status_antes_correcao = CASE
                  WHEN status = 'correcao_solicitada' THEN status_antes_correcao
                  ELSE status
                END,
                pendencias_correcao   = $1::jsonb,
                atualizado_em         = NOW()
          WHERE id = $2
          RETURNING id, status, pendencias_correcao, atualizado_em`,
        [JSON.stringify(pendencias), id]
      );

      const updated = result.rows[0];

      // Notifica o usuário provisório se houver um vinculado
      if (sol.usuario_provisorio_id) {
        const mensagem = observacao
          ? `Corrija os itens indicados e reenvie: ${observacao}`
          : 'Alguns itens precisam ser corrigidos. Abra o app para revisar.';

        enviarPushParaProvisorio(sol.usuario_provisorio_id, {
          titulo:     'Correção necessária na pré-admissão',
          mensagem,
          severidade: 'atencao',
          data: {
            acao:          'admissao_status',
            solicitacaoId: sol.id,
            status:        'correcao_solicitada',
          },
        }, sol.onesignal_subscription_id).catch(console.error);
      }

      enviarPushParaCargoNome('Administrador', {
        titulo:     'Correção solicitada',
        mensagem:   'Uma solicitação de admissão foi marcada para correção pelo candidato.',
        severidade: 'atencao',
        data:       { tipo: 'admissao_status', solicitacaoId: id, status: 'correcao_solicitada' },
        url:        '/pre-admissao',
      }).catch(console.error);

      return successResponse({
        id:                 updated.id,
        status:             updated.status,
        pendenciasCorrecao: updated.pendencias_correcao,
        atualizadoEm:       updated.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao solicitar correção:', error);
      return serverErrorResponse('Erro ao solicitar correção');
    }
  });
}
