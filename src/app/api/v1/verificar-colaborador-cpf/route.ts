import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { isValidCPF, formatCPF } from '@/lib/utils';

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const cpf = request.nextUrl.searchParams.get('cpf');

      if (!cpf) {
        return errorResponse('CPF é obrigatório', 400);
      }

      const cpfLimpo = cpf.replace(/\D/g, '');

      if (!isValidCPF(cpfLimpo)) {
        return errorResponse('CPF inválido', 400);
      }

      // Banco pode ter CPFs gravados em formatos diferentes (limpo ou
      // mascarado), então busca pelas duas formas — mesmo padrão usado
      // em /biometria/cadastrar-face-cpf.
      const result = await query(
        `SELECT id, nome, status FROM people.colaboradores
          WHERE cpf = $1 OR cpf = $2 LIMIT 1`,
        [cpfLimpo, formatCPF(cpfLimpo)]
      );

      const existe = result.rows.length > 0;

      return successResponse({
        existe,
        colaborador: existe
          ? { id: result.rows[0].id, nome: result.rows[0].nome, status: result.rows[0].status }
          : null,
      });
    } catch (error) {
      console.error('Erro ao verificar CPF:', error);
      return serverErrorResponse('Erro ao verificar CPF');
    }
  });
}
