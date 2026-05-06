import { NextRequest } from 'next/server';
import { z } from 'zod';
import { queryRecrutamentoWrite } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

/**
 * PATCH /api/v1/recrutamento/candidatos/[cpf]/pix
 *
 * Atualiza chave PIX e tipo de chave do candidato no banco externo de
 * Recrutamento (`public.candidatos`). Usado pelo modal de detalhes do
 * dia de teste — RH/gestor corrige a chave que o candidato cadastrou
 * pra que o pagamento da diária saia certo.
 *
 * Body: { chavePix: string, tipoChave?: 'cpf' | 'cnpj' | 'email' | 'telefone' | 'aleatoria' | null }
 *
 * Permissão: withGestor (qualquer gestor com escopo). Não exige escopo
 * por departamento porque a edição é "de manutenção" — RH atendendo
 * candidato pode ajustar mesmo de outra área. Auditado.
 */

const tipoChaveSchema = z.enum(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']);

const schema = z.object({
  chavePix: z.string().trim().min(1, 'chavePix obrigatória').max(120),
  tipoChave: tipoChaveSchema.nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ cpf: string }> },
) {
  return withGestor(request, async (req, user) => {
    try {
      const { cpf } = await params;
      const cpfNorm = (cpf ?? '').replace(/\D/g, '');
      if (cpfNorm.length !== 11) {
        return errorResponse('CPF inválido', 400);
      }

      const body = await req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }
      const { chavePix, tipoChave } = parsed.data;

      // Busca registro mais recente do candidato pra atualizar.
      const sel = await queryRecrutamentoWrite<{
        id: number;
        chave_pix: string | null;
        tipo_chave: string | null;
      }>(
        `SELECT id, chave_pix, tipo_chave
           FROM public.candidatos
          WHERE regexp_replace(cpf, '\\D', '', 'g') = $1
          ORDER BY data_candidatura DESC NULLS LAST, id DESC
          LIMIT 1`,
        [cpfNorm],
      );
      if (sel.rows.length === 0) {
        return notFoundResponse('Candidato não encontrado no banco de Recrutamento');
      }
      const candidato = sel.rows[0];
      const chavePixAnterior = candidato.chave_pix;
      const tipoChaveAnterior = candidato.tipo_chave;

      await queryRecrutamentoWrite(
        `UPDATE public.candidatos
            SET chave_pix = $1,
                tipo_chave = $2
          WHERE id = $3`,
        [chavePix, tipoChave ?? null, candidato.id],
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_processo_seletivo',
          descricao: `Chave PIX do candidato CPF ${cpfNorm} atualizada`,
          entidadeTipo: 'candidato_recrutamento',
          entidadeId: candidato.id,
          dadosAnteriores: {
            chavePix: chavePixAnterior,
            tipoChave: tipoChaveAnterior,
          },
          dadosNovos: { chavePix, tipoChave: tipoChave ?? null },
        }),
      );

      return successResponse({
        cpf: cpfNorm,
        chavePix,
        tipoChave: tipoChave ?? null,
      });
    } catch (e) {
      console.error('[recrutamento/candidatos/pix] erro:', e);
      return serverErrorResponse('Erro ao atualizar chave PIX');
    }
  });
}
