import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const prestadorId = parseInt(id);

      if (isNaN(prestadorId)) {
        return notFoundResponse('Prestador não encontrado');
      }

      const prestador = await cacheAside(`${CACHE_KEYS.PRESTADOR}${prestadorId}`, async () => {
        const result = await query(
          `SELECT 
            p.id,
            p.razao_social,
            p.nome_fantasia,
            p.cnpj_cpf,
            p.tipo,
            p.email,
            p.telefone,
            p.endereco,
            p.area_atuacao,
            p.status,
            p.observacoes,
            p.criado_em,
            p.atualizado_em
          FROM people.prestadores p
          WHERE p.id = $1`,
          [prestadorId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];
        return {
          id: row.id,
          razaoSocial: row.razao_social,
          nomeFantasia: row.nome_fantasia,
          cnpjCpf: row.cnpj_cpf,
          tipo: row.tipo,
          email: row.email,
          telefone: row.telefone,
          endereco: row.endereco,
          areaAtuacao: row.area_atuacao,
          status: row.status,
          observacoes: row.observacoes,
          createdAt: row.criado_em,
          updatedAt: row.atualizado_em,
        };
      }, CACHE_TTL.SHORT);

      if (!prestador) {
        return notFoundResponse('Prestador não encontrado');
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'visualizar',
        modulo: 'prestadores',
        descricao: 'Visualização de dados do prestador',
        entidadeId: prestadorId,
        entidadeTipo: 'prestador',
      }));

      return successResponse(prestador);
    } catch (error) {
      console.error('Erro ao obter prestador:', error);
      return serverErrorResponse('Erro ao obter prestador');
    }
  });
}
