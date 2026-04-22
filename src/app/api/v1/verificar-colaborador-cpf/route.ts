import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { isValidCPF } from '@/lib/utils';

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

      const result = await query(
        `SELECT id, nome, status FROM people.colaboradores WHERE cpf = $1 LIMIT 1`,
        [cpfLimpo]
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
