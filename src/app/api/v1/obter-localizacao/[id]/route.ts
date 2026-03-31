import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const localizacaoId = parseInt(id);

      if (isNaN(localizacaoId)) {
        return notFoundResponse('Localização não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.LOCALIZACAO}${localizacaoId}`;

      const dados = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT * FROM localizacoes WHERE id = $1`,
          [localizacaoId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        // Buscar departamentos vinculados
        const deptResult = await query(
          `SELECT d.id, d.nome 
           FROM localizacao_departamentos ld
           JOIN departamentos d ON ld.departamento_id = d.id
           WHERE ld.localizacao_id = $1`,
          [localizacaoId]
        );

        return {
          id: row.id,
          nome: row.nome,
          tipo: row.tipo,
          endereco: {
            cep: row.endereco_cep,
            logradouro: row.endereco_logradouro,
            numero: row.endereco_numero,
            complemento: row.endereco_complemento,
            bairro: row.endereco_bairro,
            cidade: row.endereco_cidade,
            estado: row.endereco_estado,
          },
          coordenadas: {
            latitude: parseFloat(row.latitude),
            longitude: parseFloat(row.longitude),
          },
          raioPermitido: row.raio_permitido,
          horariosFuncionamento: row.horarios_funcionamento,
          departamentos: deptResult.rows,
          status: row.status,
        };
      }, CACHE_TTL.MEDIUM);

      if (!dados) {
        return notFoundResponse('Localização não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter localização:', error);
      return serverErrorResponse('Erro ao obter localização');
    }
  });
}
