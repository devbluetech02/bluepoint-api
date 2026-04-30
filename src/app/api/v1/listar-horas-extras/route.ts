import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, forbiddenResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { resolverColaboradorIdComAcesso, obterEscopoGestor, listarColaboradoresNoEscopo } from '@/lib/escopo-gestor';
import { isSuperAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const colaboradorId = searchParams.get('colaboradorId');
      const departamentoId = searchParams.get('departamentoId');
      const status = searchParams.get('status');
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');

      // Escopo: super admin / API key veem tudo; demais limitam ao próprio +
      // escopo de gestão. Param `colaboradorId` é validado individualmente.
      const colaboradorIdNum = colaboradorId ? parseInt(colaboradorId, 10) : null;
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

      const cacheKey = buildListCacheKey(CACHE_KEYS.HORAS_EXTRAS, {
        pagina, limite, colaboradorId, departamentoId, status, dataInicio, dataFim, scope: cacheScope,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = ["s.tipo = 'hora_extra'"];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (colaboradorIdNum != null) {
          conditions.push(`s.colaborador_id = $${paramIndex}`);
          params.push(colaboradorIdNum);
          paramIndex++;
        } else if (colaboradorIdsPermitidos != null) {
          if (colaboradorIdsPermitidos.length === 0) {
            return {
              dados: [], total: 0, pagina, limite,
              totalizadores: { totalRegistros: 0, pendentes: 0, aprovadas: 0, rejeitadas: 0, totalHorasAprovadas: 0, totalColaboradores: 0 },
            };
          }
          conditions.push(`s.colaborador_id = ANY($${paramIndex}::int[])`);
          params.push(colaboradorIdsPermitidos);
          paramIndex++;
        }

        if (departamentoId) {
          conditions.push(`c.departamento_id = $${paramIndex}`);
          params.push(parseInt(departamentoId));
          paramIndex++;
        }

        if (status) {
          conditions.push(`s.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (dataInicio) {
          conditions.push(`s.data_evento >= $${paramIndex}`);
          params.push(dataInicio);
          paramIndex++;
        }

        if (dataFim) {
          conditions.push(`s.data_evento <= $${paramIndex}`);
          params.push(dataFim);
          paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total
           FROM solicitacoes s
           JOIN people.colaboradores c ON s.colaborador_id = c.id
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados paginados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            s.id,
            s.colaborador_id,
            c.nome as colaborador_nome,
            d.nome as departamento,
            s.status,
            s.data_evento,
            s.descricao,
            s.justificativa,
            s.dados_adicionais,
            s.data_solicitacao,
            s.data_aprovacao,
            a.id as aprovador_id,
            a.nome as aprovador_nome,
            (SELECT COUNT(*) FROM anexos WHERE solicitacao_id = s.id) as total_anexos
          FROM solicitacoes s
          JOIN people.colaboradores c ON s.colaborador_id = c.id
          LEFT JOIN departamentos d ON c.departamento_id = d.id
          LEFT JOIN people.colaboradores a ON s.aprovador_id = a.id
          ${whereClause}
          ORDER BY s.data_solicitacao DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => {
          const extras = row.dados_adicionais || {};
          return {
            id: row.id,
            colaborador: {
              id: row.colaborador_id,
              nome: row.colaborador_nome,
            },
            departamento: row.departamento,
            status: row.status,
            data: extras.data || row.data_evento,
            horaInicio: extras.horaInicio || null,
            horaFim: extras.horaFim || null,
            totalHoras: extras.totalHoras || null,
            motivo: extras.motivo || null,
            descricao: row.descricao,
            justificativa: row.justificativa,
            observacao: extras.observacao || null,
            dataSolicitacao: row.data_solicitacao,
            dataAprovacao: row.data_aprovacao,
            aprovador: row.aprovador_id ? { id: row.aprovador_id, nome: row.aprovador_nome } : null,
            anexos: parseInt(row.total_anexos),
          };
        });

        // Calcular totalizadores
        const totaisResult = await query(
          `SELECT 
            COUNT(*) as total_registros,
            COUNT(*) FILTER (WHERE s.status = 'pendente') as pendentes,
            COUNT(*) FILTER (WHERE s.status = 'aprovada') as aprovadas,
            COUNT(*) FILTER (WHERE s.status = 'rejeitada') as rejeitadas,
            COALESCE(SUM((s.dados_adicionais->>'totalHoras')::numeric) FILTER (WHERE s.status = 'aprovada'), 0) as total_horas_aprovadas,
            COUNT(DISTINCT s.colaborador_id) as total_colaboradores
          FROM solicitacoes s
          JOIN people.colaboradores c ON s.colaborador_id = c.id
          ${whereClause}`,
          params
        );

        const totais = totaisResult.rows[0];

        return {
          dados,
          total,
          pagina,
          limite,
          totalizadores: {
            totalRegistros: parseInt(totais.total_registros),
            pendentes: parseInt(totais.pendentes),
            aprovadas: parseInt(totais.aprovadas),
            rejeitadas: parseInt(totais.rejeitadas),
            totalHorasAprovadas: parseFloat(totais.total_horas_aprovadas) || 0,
            totalColaboradores: parseInt(totais.total_colaboradores),
          },
        };
      }, CACHE_TTL.SHORT);

      const response = buildPaginatedResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);

      return successResponse({
        ...response,
        totalizadores: resultado.totalizadores,
      });
    } catch (error) {
      console.error('Erro ao listar horas extras:', error);
      return serverErrorResponse('Erro ao listar horas extras');
    }
  });
}
