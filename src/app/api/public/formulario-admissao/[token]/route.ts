import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { mapCamposParaApi } from '@/lib/formulario-admissao';

interface Params {
  params: Promise<{ token: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { token } = await params;

    const result = await query(
      `SELECT id, titulo, descricao, campos, ativo
       FROM people.formularios_admissao
       WHERE token_publico = $1
         AND ativo = true
       LIMIT 1`,
      [token]
    );

    if (result.rows.length === 0) {
      return notFoundResponse('Formulário de admissão não encontrado');
    }

    const row = result.rows[0];
    return successResponse({
      id: row.id,
      titulo: row.titulo,
      descricao: row.descricao,
      campos: mapCamposParaApi(row.campos),
      ativo: row.ativo,
    });
  } catch (error) {
    console.error('Erro ao obter formulário de admissão público:', error);
    return serverErrorResponse('Erro ao obter formulário de admissão');
  }
}
