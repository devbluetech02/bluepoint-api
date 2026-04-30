import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, forbiddenResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { resolverColaboradorIdComAcesso, obterEscopoGestor, listarColaboradoresNoEscopo } from '@/lib/escopo-gestor';
import { isSuperAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const colaboradorId = searchParams.get('colaboradorId');
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const ativo = searchParams.get('ativo');

      // Escopo: super admin / API key veem tudo; demais limitam ao próprio
      // (e ao escopo de gestão se aplicável). Param `colaboradorId` exige
      // validação via resolverColaboradorIdComAcesso.
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

      const conditions: string[] = [];
      const params: unknown[] = [];
      let pi = 1;

      if (colaboradorIdNum != null) {
        conditions.push(`pf.colaborador_id = $${pi}`);
        params.push(colaboradorIdNum);
        pi++;
      } else if (colaboradorIdsPermitidos != null) {
        if (colaboradorIdsPermitidos.length === 0) {
          return paginatedSuccessResponse([], 0, pagina, limite);
        }
        conditions.push(`pf.colaborador_id = ANY($${pi}::int[])`);
        params.push(colaboradorIdsPermitidos);
        pi++;
      }

      if (dataInicio) {
        conditions.push(`pf.data_fim >= $${pi}::date`);
        params.push(dataInicio);
        pi++;
      }

      if (dataFim) {
        conditions.push(`pf.data_inicio <= $${pi}::date`);
        params.push(dataFim);
        pi++;
      }

      if (ativo === 'true') {
        conditions.push(`pf.data_fim >= CURRENT_DATE`);
      } else if (ativo === 'false') {
        conditions.push(`pf.data_fim < CURRENT_DATE`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await query(
        `SELECT COUNT(*) as total FROM people.periodos_ferias pf ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT
          pf.id,
          pf.colaborador_id,
          c.nome as colaborador_nome,
          pf.data_inicio,
          pf.data_fim,
          pf.solicitacao_id,
          pf.observacao,
          pf.designado_por,
          d.nome as designado_por_nome,
          pf.criado_em,
          (pf.data_fim::date - pf.data_inicio::date + 1) as dias
        FROM people.periodos_ferias pf
        JOIN people.colaboradores c ON pf.colaborador_id = c.id
        LEFT JOIN people.colaboradores d ON pf.designado_por = d.id
        ${whereClause}
        ORDER BY pf.data_inicio DESC
        LIMIT $${pi} OFFSET $${pi + 1}`,
        dataParams
      );

      const dados = result.rows.map(row => ({
        id: row.id,
        colaborador: { id: row.colaborador_id, nome: row.colaborador_nome },
        dataInicio: row.data_inicio,
        dataFim: row.data_fim,
        dias: parseInt(row.dias),
        solicitacaoId: row.solicitacao_id,
        observacao: row.observacao,
        designadoPor: row.designado_por ? { id: row.designado_por, nome: row.designado_por_nome } : null,
        criadoEm: row.criado_em,
      }));

      return paginatedSuccessResponse(dados, total, pagina, limite);
    } catch (error) {
      console.error('Erro ao listar férias:', error);
      return serverErrorResponse('Erro ao listar férias');
    }
  });
}
