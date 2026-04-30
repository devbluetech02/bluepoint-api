import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { isSuperAdmin } from '@/lib/auth';
import { obterEscopoGestor } from '@/lib/escopo-gestor';

export async function GET(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const status = searchParams.get('status');
      const prioridade = searchParams.get('prioridade');
      const destinatarioId = searchParams.get('destinatarioId');
      const departamentoId = searchParams.get('departamentoId');
      const tipo = searchParams.get('tipo');

      // Escopo: gestor comum só vê pendências do próprio escopo
      // (destinatário=ele, ou departamento dentro do escopo de gestão).
      // Super admin / API key veem tudo.
      const escopoGlobal = isSuperAdmin(user) || user.userId < 0;
      let escopo: { departamentoIds: number[]; empresaIds: number[] } | null = null;
      if (!escopoGlobal) {
        escopo = await obterEscopoGestor(user.userId);
      }

      const cacheScope = escopoGlobal ? 'admin' : `u${user.userId}`;
      const cacheKey = buildListCacheKey(CACHE_KEYS.PENDENCIAS, {
        pagina, limite, status, prioridade, destinatarioId, departamentoId, tipo, scope: cacheScope,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        // Restrição de escopo: pendência precisa ter destinatario_id == user
        // OU departamento_id dentro do escopo do gestor.
        if (escopo !== null) {
          const escopoConds: string[] = [`p.destinatario_id = $${paramIndex}`];
          params.push(user.userId);
          paramIndex++;
          if (escopo.departamentoIds.length > 0) {
            escopoConds.push(`p.departamento_id = ANY($${paramIndex}::int[])`);
            params.push(escopo.departamentoIds);
            paramIndex++;
          }
          conditions.push(`(${escopoConds.join(' OR ')})`);
        }

        if (status) {
          conditions.push(`p.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (prioridade) {
          conditions.push(`p.prioridade = $${paramIndex}`);
          params.push(prioridade);
          paramIndex++;
        }

        if (destinatarioId) {
          conditions.push(`p.destinatario_id = $${paramIndex}`);
          params.push(parseInt(destinatarioId));
          paramIndex++;
        }

        if (departamentoId) {
          conditions.push(`p.departamento_id = $${paramIndex}`);
          params.push(parseInt(departamentoId));
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`p.tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) AS total
           FROM people.pendencias p
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT
            p.id,
            p.titulo,
            p.tipo,
            p.status,
            p.prioridade,
            p.origem,
            p.data_limite,
            p.resolvido_em,
            p.criado_em,
            d.id AS destinatario_id,
            d.nome AS destinatario_nome,
            dep.id AS departamento_id,
            dep.nome AS departamento_nome
          FROM people.pendencias p
          LEFT JOIN people.colaboradores d ON p.destinatario_id = d.id
          LEFT JOIN people.departamentos dep ON p.departamento_id = dep.id
          ${whereClause}
          ORDER BY
            CASE p.prioridade
              WHEN 'critica' THEN 1
              WHEN 'alta' THEN 2
              WHEN 'media' THEN 3
              ELSE 4
            END,
            p.criado_em DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map((row) => ({
          id: row.id,
          titulo: row.titulo,
          tipo: row.tipo,
          status: row.status,
          prioridade: row.prioridade,
          origem: row.origem,
          dataLimite: row.data_limite,
          resolvidoEm: row.resolvido_em,
          criadoEm: row.criado_em,
          destinatario: row.destinatario_id
            ? { id: row.destinatario_id, nome: row.destinatario_nome }
            : null,
          departamento: row.departamento_id
            ? { id: row.departamento_id, nome: row.departamento_nome }
            : null,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar pendências:', error);
      return serverErrorResponse('Erro ao listar pendências');
    }
  });
}
