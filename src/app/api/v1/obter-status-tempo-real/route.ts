import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const departamentoId = searchParams.get('departamentoId');

      const cacheKey = buildListCacheKey(CACHE_KEYS.STATUS_TEMPO_REAL, { departamentoId });

      const dados = await cacheAside(cacheKey, async () => {
      // Status tempo real ignora cargos de confiança — quem não bate ponto
      // não tem "trabalhando/almoço/ausente" para reportar.
      let whereClause = "WHERE c.status = 'ativo' AND COALESCE(cg.cargo_confianca, FALSE) = FALSE";
      const params: unknown[] = [];

      if (departamentoId) {
        whereClause += ' AND c.departamento_id = $1';
        params.push(parseInt(departamentoId));
      }

      const result = await query(
        `SELECT
          c.id,
          c.nome,
          d.nome as departamento,
          (
            SELECT tipo FROM people.marcacoes
            WHERE colaborador_id = c.id AND DATE(data_hora) = CURRENT_DATE
            ORDER BY data_hora DESC LIMIT 1
          ) as ultima_marcacao_tipo,
          (
            SELECT data_hora FROM people.marcacoes
            WHERE colaborador_id = c.id AND DATE(data_hora) = CURRENT_DATE
            ORDER BY data_hora DESC LIMIT 1
          ) as ultima_marcacao_hora
        FROM people.colaboradores c
        LEFT JOIN departamentos d ON c.departamento_id = d.id
        LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
        ${whereClause}
        ORDER BY c.nome`,
        params
      );

      const agora = new Date();
      let trabalhando = 0;
      let ausentes = 0;
      let almoco = 0;

      const colaboradores = result.rows.map(row => {
        let status = 'ausente';
        let tempoDecorrido = '';

        if (row.ultima_marcacao_tipo === 'entrada' || row.ultima_marcacao_tipo === 'retorno') {
          status = 'trabalhando';
          trabalhando++;
          
          const entrada = new Date(row.ultima_marcacao_hora);
          const diffMs = agora.getTime() - entrada.getTime();
          const diffHoras = Math.floor(diffMs / (1000 * 60 * 60));
          const diffMinutos = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
          tempoDecorrido = `${diffHoras}h ${diffMinutos}min`;
        } else if (row.ultima_marcacao_tipo === 'almoco') {
          status = 'almoco';
          almoco++;
        } else if (row.ultima_marcacao_tipo === 'saida') {
          status = 'saiu';
        } else {
          ausentes++;
        }

        return {
          id: row.id,
          nome: row.nome,
          departamento: row.departamento,
          status,
          ultimaMarcacao: row.ultima_marcacao_tipo ? {
            tipo: row.ultima_marcacao_tipo,
            dataHora: row.ultima_marcacao_hora,
          } : null,
          tempoDecorrido,
        };
      });

      return {
        dataHora: agora.toISOString(),
        colaboradores,
        resumo: {
          trabalhando,
          ausentes,
          almoco,
        },
      };
      }, CACHE_TTL.SHORT);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter status em tempo real:', error);
      return serverErrorResponse('Erro ao obter status');
    }
  });
}
