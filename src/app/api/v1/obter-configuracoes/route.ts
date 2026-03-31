import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      const configuracoes = await cacheAside(`${CACHE_KEYS.CONFIGURACOES}all`, async () => {
        // Buscar configurações por categoria
        const result = await query(
          `SELECT categoria, chave, valor FROM configuracoes ORDER BY categoria, chave`
        );

        // Agrupar por categoria
        const configs: Record<string, Record<string, string>> = {};
        for (const row of result.rows) {
          if (!configs[row.categoria]) {
            configs[row.categoria] = {};
          }
          configs[row.categoria][row.chave] = row.valor;
        }

        // Buscar dados da empresa
        const empresaResult = await query(
          `SELECT * FROM configuracoes_empresa LIMIT 1`
        );

        const empresa = empresaResult.rows[0] || {};

        return {
          geral: configs.geral || {},
          ponto: configs.ponto || {},
          notificacoes: configs.notificacoes || {},
          integracao: configs.integracao || {},
          empresa: {
            razaoSocial: empresa.razao_social,
            nomeFantasia: empresa.nome_fantasia,
            cnpj: empresa.cnpj,
            logo: empresa.logo_url,
          },
        };
      }, CACHE_TTL.LONG);

      return successResponse(configuracoes);
    } catch (error) {
      console.error('Erro ao obter configurações:', error);
      return serverErrorResponse('Erro ao obter configurações');
    }
  });
}
