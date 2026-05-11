import { NextRequest } from 'next/server';
import { atualizarTelefoneCandidatoRecrutamentoPorCpf } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
} from '@/lib/api-response';

// PATCH /api/v1/recrutamento/candidatos/:cpf/telefone
// Atualiza telefone da candidatura mais recente do CPF no banco externo.

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ cpf: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { cpf } = await params;
      const cpfNorm = (cpf ?? '').replace(/\D/g, '');
      if (cpfNorm.length !== 11) {
        return errorResponse('CPF invalido', 400);
      }

      const body = (await request.json().catch(() => null)) as {
        telefone?: unknown;
      } | null;
      const telefone = String(body?.telefone ?? '').replace(/\D/g, '');
      if (telefone.length < 10 || telefone.length > 13) {
        return errorResponse('Telefone deve ter entre 10 e 13 digitos', 400);
      }

      const result = await atualizarTelefoneCandidatoRecrutamentoPorCpf(
        cpfNorm,
        telefone
      );
      const row = result.rows[0];
      if (!row) {
        return notFoundResponse(
          'Candidato nao encontrado no banco de Recrutamento'
        );
      }

      return successResponse({
        id: row.id,
        telefone: (row.telefone ?? '').replace(/\D/g, '') || null,
      });
    } catch (error) {
      console.error('[recrutamento/candidatos/:cpf/telefone] erro:', error);
      return serverErrorResponse('Erro ao atualizar telefone do candidato');
    }
  });
}
