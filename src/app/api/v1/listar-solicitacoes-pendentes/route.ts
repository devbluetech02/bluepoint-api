import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      
      const departamentoId = searchParams.get('departamentoId');
      const tipo = searchParams.get('tipo');
      const gestorId = searchParams.get('gestorId');

      const cacheKey = buildListCacheKey(CACHE_KEYS.SOLICITACOES, {
        tipo: 'pendentes', pagina, limite, departamentoId, tipoSolicitacao: tipo, gestorId,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      const conditions: string[] = ["s.status = 'pendente'"];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (departamentoId) {
        conditions.push(`c.departamento_id = $${paramIndex}`);
        params.push(parseInt(departamentoId));
        paramIndex++;
      }

      if (tipo) {
        conditions.push(`s.tipo = $${paramIndex}`);
        params.push(tipo);
        paramIndex++;
      }

      if (gestorId) {
        conditions.push(`s.gestor_id = $${paramIndex}`);
        params.push(parseInt(gestorId));
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total 
         FROM bt_solicitacoes s
         JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id
         ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      // Buscar dados
      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT 
          s.id,
          s.tipo,
          s.status,
          s.data_solicitacao,
          s.data_evento,
          s.descricao,
          c.id as colaborador_id,
          c.nome as colaborador_nome,
          d.id as departamento_id,
          d.nome as departamento_nome,
          g.id as gestor_id,
          g.nome as gestor_nome
        FROM bt_solicitacoes s
        JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id
        LEFT JOIN bt_departamentos d ON c.departamento_id = d.id
        LEFT JOIN bluepoint.bt_colaboradores g ON s.gestor_id = g.id
        ${whereClause}
        ORDER BY s.data_solicitacao ASC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const dados = result.rows.map(row => ({
        id: row.id,
        colaborador: { id: row.colaborador_id, nome: row.colaborador_nome },
        departamento: row.departamento_id ? { id: row.departamento_id, nome: row.departamento_nome } : null,
        gestor: row.gestor_id ? { id: row.gestor_id, nome: row.gestor_nome } : null,
        tipo: row.tipo,
        status: row.status,
        dataSolicitacao: row.data_solicitacao,
        dataEvento: row.data_evento,
        descricao: row.descricao,
      }));

      return {
        ...buildPaginatedResponse(dados, total, pagina, limite),
        total,
      };
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar solicitações pendentes:', error);
      return serverErrorResponse('Erro ao listar solicitações');
    }
  });
}
