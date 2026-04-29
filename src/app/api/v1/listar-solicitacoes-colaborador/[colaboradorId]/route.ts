import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, forbiddenResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const acesso = await asseguraAcessoColaborador(user, colaboradorId);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const status = searchParams.get('status');
      const tipo = searchParams.get('tipo');

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = buildListCacheKey(CACHE_KEYS.SOLICITACOES, {
        scope: 'colaborador', colaboradorId, pagina, limite, status, tipo,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      // Construir filtros
      const conditions: string[] = ['s.colaborador_id = $1'];
      const params_query: unknown[] = [colaboradorId];
      let paramIndex = 2;

      if (status) {
        conditions.push(`s.status = $${paramIndex}`);
        params_query.push(status);
        paramIndex++;
      }

      if (tipo) {
        conditions.push(`s.tipo = $${paramIndex}`);
        params_query.push(tipo);
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total FROM solicitacoes s ${whereClause}`,
        params_query
      );
      const total = parseInt(countResult.rows[0].total);

      // Buscar solicitações
      const dataParams = [...params_query, limite, offset];
      const result = await query(
        `SELECT 
          s.id,
          s.tipo,
          s.status,
          s.data_solicitacao,
          s.data_evento,
          s.descricao,
          s.data_aprovacao,
          a.id as aprovador_id,
          a.nome as aprovador_nome,
          g.id as gestor_id,
          g.nome as gestor_nome
        FROM solicitacoes s
        LEFT JOIN people.colaboradores a ON s.aprovador_id = a.id
        LEFT JOIN people.colaboradores g ON s.gestor_id = g.id
        ${whereClause}
        ORDER BY s.data_solicitacao DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      const dados = result.rows.map(row => ({
        id: row.id,
        tipo: row.tipo,
        status: row.status,
        dataSolicitacao: row.data_solicitacao,
        dataEvento: row.data_evento,
        descricao: row.descricao,
        gestor: row.gestor_id ? { id: row.gestor_id, nome: row.gestor_nome } : null,
        aprovador: row.aprovador_id ? { id: row.aprovador_id, nome: row.aprovador_nome } : null,
        dataAprovacao: row.data_aprovacao,
      }));

      // Buscar resumo
      const resumoResult = await query(
        `SELECT 
          SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) as pendentes,
          SUM(CASE WHEN status = 'aprovada' THEN 1 ELSE 0 END) as aprovadas,
          SUM(CASE WHEN status = 'rejeitada' THEN 1 ELSE 0 END) as rejeitadas
        FROM solicitacoes
        WHERE colaborador_id = $1`,
        [colaboradorId]
      );

      const resumo = resumoResult.rows[0];

      return {
        ...buildPaginatedResponse(dados, total, pagina, limite),
        resumo: {
          pendentes: parseInt(resumo.pendentes) || 0,
          aprovadas: parseInt(resumo.aprovadas) || 0,
          rejeitadas: parseInt(resumo.rejeitadas) || 0,
        },
      };
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar solicitações do colaborador:', error);
      return serverErrorResponse('Erro ao listar solicitações');
    }
  });
}
