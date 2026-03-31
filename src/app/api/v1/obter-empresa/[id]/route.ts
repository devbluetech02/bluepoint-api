import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const empresaId = parseInt(id);

      if (isNaN(empresaId)) {
        return notFoundResponse('Empresa não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.EMPRESA}${empresaId}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT 
          id,
          razao_social,
          nome_fantasia,
          cnpj,
          celular,
          cep,
          estado,
          cidade,
          bairro,
          rua,
          numero,
          created_at,
          updated_at
        FROM people.empresas
        WHERE id = $1`,
        [empresaId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        id: row.id,
        razaoSocial: row.razao_social,
        nomeFantasia: row.nome_fantasia,
        cnpj: row.cnpj,
        celular: row.celular,
        endereco: {
          cep: row.cep,
          estado: row.estado,
          cidade: row.cidade,
          bairro: row.bairro,
          rua: row.rua,
          numero: row.numero,
        },
        criadoEm: row.created_at,
        atualizadoEm: row.updated_at,
      };
      }, CACHE_TTL.LONG);

      if (!dados) {
        return notFoundResponse('Empresa não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter empresa:', error);
      return serverErrorResponse('Erro ao obter empresa');
    }
  });
}
