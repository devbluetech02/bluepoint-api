import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const modeloId = parseInt(id);

      if (isNaN(modeloId)) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const modeloResult = await query(
        `SELECT id, nome, descricao, ativo, criado_em, atualizado_em
         FROM people.modelos_exportacao
         WHERE id = $1`,
        [modeloId]
      );

      if (modeloResult.rows.length === 0) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const modelo = modeloResult.rows[0];

      const codigosResult = await query(
        `SELECT id, codigo, descricao, status_arquivo, status_econtador
         FROM people.codigos_exportacao
         WHERE modelo_id = $1
         ORDER BY id`,
        [modeloId]
      );

      const codigos = codigosResult.rows.map(row => ({
        id: row.id,
        codigo: row.codigo,
        descricao: row.descricao,
        statusArquivo: row.status_arquivo,
        statusEContador: row.status_econtador,
      }));

      return successResponse({
        id: modelo.id,
        nome: modelo.nome,
        descricao: modelo.descricao,
        ativo: modelo.ativo,
        codigos,
        criadoEm: modelo.criado_em,
        atualizadoEm: modelo.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao obter modelo de exportação:', error);
      return serverErrorResponse('Erro ao obter modelo de exportação');
    }
  });
}
