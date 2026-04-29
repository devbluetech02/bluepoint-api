import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, forbiddenResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { resolverColaboradorIdComAcesso, obterEscopoGestor, listarColaboradoresNoEscopo } from '@/lib/escopo-gestor';
import { isSuperAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const colaboradorIdParam = searchParams.get('colaboradorId');
      const tipo = searchParams.get('tipo');
      const status = searchParams.get('status');
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const gestorId = searchParams.get('gestorId');

      const colaboradorIdNum = colaboradorIdParam ? parseInt(colaboradorIdParam, 10) : null;
      let colaboradorIdsPermitidos: number[] | null = null;

      if (!isSuperAdmin(user) && user.userId > 0) {
        if (colaboradorIdNum != null) {
          const acesso = await resolverColaboradorIdComAcesso(user, colaboradorIdNum);
          if (!acesso.permitido) {
            return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
          }
        } else {
          const escopo = await obterEscopoGestor(user.userId);
          colaboradorIdsPermitidos = await listarColaboradoresNoEscopo(escopo);
          if (!colaboradorIdsPermitidos.includes(user.userId)) {
            colaboradorIdsPermitidos.push(user.userId);
          }
        }
      }

      const cacheScope = isSuperAdmin(user) || user.userId < 0
        ? 'admin'
        : (colaboradorIdNum != null ? `c${colaboradorIdNum}` : `u${user.userId}`);

      const cacheKey = buildListCacheKey(CACHE_KEYS.SOLICITACOES, {
        pagina, limite, colaboradorId: colaboradorIdParam, tipo, status, dataInicio, dataFim, gestorId, scope: cacheScope,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (colaboradorIdNum != null) {
          conditions.push(`s.colaborador_id = $${paramIndex}`);
          params.push(colaboradorIdNum);
          paramIndex++;
        } else if (colaboradorIdsPermitidos != null) {
          conditions.push(`s.colaborador_id = ANY($${paramIndex}::int[])`);
          params.push(colaboradorIdsPermitidos);
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`s.tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        if (status) {
          conditions.push(`s.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (dataInicio) {
          conditions.push(`s.data_solicitacao >= $${paramIndex}`);
          params.push(dataInicio);
          paramIndex++;
        }

        if (dataFim) {
          conditions.push(`s.data_solicitacao <= $${paramIndex}::date + interval '1 day'`);
          params.push(dataFim);
          paramIndex++;
        }

        if (gestorId) {
          conditions.push(`s.gestor_id = $${paramIndex}`);
          params.push(parseInt(gestorId));
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM solicitacoes s ${whereClause}`,
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
            s.data_aprovacao,
            s.criado_em,
            c.id as colaborador_id,
            c.nome as colaborador_nome,
            a.id as aprovador_id,
            a.nome as aprovador_nome,
            g.id as gestor_id,
            g.nome as gestor_nome,
            COALESCE(anx.total, 0) as anexos
          FROM solicitacoes s
          JOIN people.colaboradores c ON s.colaborador_id = c.id
          LEFT JOIN people.colaboradores a ON s.aprovador_id = a.id
          LEFT JOIN people.colaboradores g ON s.gestor_id = g.id
          LEFT JOIN (
            SELECT solicitacao_id, COUNT(*) as total
            FROM anexos
            GROUP BY solicitacao_id
          ) anx ON s.id = anx.solicitacao_id
          ${whereClause}
          ORDER BY s.data_solicitacao DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          colaborador: { id: row.colaborador_id, nome: row.colaborador_nome },
          tipo: row.tipo,
          status: row.status,
          dataSolicitacao: row.data_solicitacao,
          dataEvento: row.data_evento,
          descricao: row.descricao,
          gestor: row.gestor_id ? { id: row.gestor_id, nome: row.gestor_nome } : null,
          aprovador: row.aprovador_id ? { id: row.aprovador_id, nome: row.aprovador_nome } : null,
          dataAprovacao: row.data_aprovacao,
          criadoEm: row.criado_em,
          anexos: parseInt(row.anexos),
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar solicitações:', error);
      return serverErrorResponse('Erro ao listar solicitações');
    }
  });
}
