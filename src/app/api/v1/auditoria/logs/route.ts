import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, serverErrorResponse, paginatedSuccessResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const params = req.nextUrl.searchParams;

      const dataInicio = params.get('dataInicio');
      const dataFim = params.get('dataFim');
      const modulo = params.get('modulo');
      const acao = params.get('acao');
      const busca = params.get('busca');
      const colaboradorId = params.get('colaboradorId');
      const pagina = Math.max(1, parseInt(params.get('pagina') || '1'));
      const limite = Math.min(50, Math.max(1, parseInt(params.get('limite') || '20')));
      const offset = (pagina - 1) * limite;

      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIdx = 1;

      if (dataInicio) {
        conditions.push(`a.data_hora >= $${paramIdx}::date`);
        values.push(dataInicio);
        paramIdx++;
      }

      if (dataFim) {
        conditions.push(`a.data_hora < ($${paramIdx}::date + interval '1 day')`);
        values.push(dataFim);
        paramIdx++;
      }

      if (modulo) {
        conditions.push(`a.modulo = $${paramIdx}`);
        values.push(modulo);
        paramIdx++;
      }

      if (acao) {
        conditions.push(`a.acao = $${paramIdx}`);
        values.push(acao);
        paramIdx++;
      }

      if (colaboradorId) {
        const colabIdNum = parseInt(colaboradorId);
        if (isNaN(colabIdNum)) {
          return errorResponse('colaboradorId deve ser um número', 400);
        }
        conditions.push(`a.colaborador_id = $${paramIdx}`);
        values.push(colabIdNum);
        paramIdx++;
      }

      if (busca) {
        conditions.push(
          `(c.nome ILIKE $${paramIdx} OR a.descricao ILIKE $${paramIdx} OR a.modulo ILIKE $${paramIdx} OR a.acao ILIKE $${paramIdx})`
        );
        values.push(`%${busca}%`);
        paramIdx++;
      }

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*) as total
         FROM auditoria a
         LEFT JOIN colaboradores c ON a.usuario_id = c.id
         ${whereClause}`,
        values
      );

      const total = parseInt(countResult.rows[0].total);

      const dataValues = [...values, limite, offset];
      const result = await query(
        `SELECT
           a.id,
           a.data_hora      AS "dataHora",
           a.usuario_id     AS "usuarioId",
           c.nome           AS "usuarioNome",
           c.email          AS "usuarioEmail",
           a.acao,
           a.modulo,
           a.descricao      AS "detalhes",
           a.ip,
           a.user_agent     AS "userAgent",
           a.entidade_id    AS "entidadeId",
           a.entidade_tipo  AS "entidadeTipo",
           a.colaborador_id   AS "colaboradorId",
           a.colaborador_nome AS "colaboradorNome"
         FROM auditoria a
         LEFT JOIN colaboradores c ON a.usuario_id = c.id
         ${whereClause}
         ORDER BY a.data_hora DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        dataValues
      );

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'visualizar',
        modulo: 'auditoria',
        descricao: colaboradorId
          ? `Consulta de logs do colaborador #${colaboradorId}`
          : 'Consulta de logs de auditoria',
        colaboradorId: colaboradorId ? parseInt(colaboradorId) : undefined,
      }));

      return paginatedSuccessResponse(
        result.rows,
        total,
        pagina,
        limite
      );
    } catch (error) {
      console.error('Erro ao listar logs de auditoria:', error);
      return serverErrorResponse('Erro ao listar logs de auditoria');
    }
  });
}
