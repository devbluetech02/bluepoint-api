import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  paginatedSuccessResponse,
  serverErrorResponse,
  getPaginationParams,
  getOrderParams,
} from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

/** Palavras que caracterizam cargo de supervisor (match case-insensitive no nome do cargo) */
const PALAVRAS_SUPERVISOR = ['supervisor', 'supervisora', 'supervisor(a)'];

function buildSupervisorCargoCondition(): string {
  const conditions = PALAVRAS_SUPERVISOR.map(
    (_, i) => `cg.nome ILIKE $${i + 1}`
  ).join(' OR ');
  return `(${conditions})`;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const { orderBy, orderDir } = getOrderParams(searchParams, [
        'nome',
        'email',
        'data_admissao',
        'criado_em',
      ]);

      const busca = searchParams.get('busca');
      const departamentoId = searchParams.get('filtro[departamentoId]');
      const status = searchParams.get('filtro[status]');

      const cargoParams = PALAVRAS_SUPERVISOR.map((p) => `%${p}%`);
      const supervisorCondition = buildSupervisorCargoCondition();

      const cacheKey = buildListCacheKey(
        `${CACHE_KEYS.COLABORADORES}supervisores:`,
        { pagina, limite, orderBy, orderDir, busca: busca ?? '', departamentoId: departamentoId ?? '', status: status ?? '' }
      );

      const resultado = await cacheAside(
        cacheKey,
        async () => {
          const conditions: string[] = [`${supervisorCondition}`];
          const params: unknown[] = [...cargoParams];
          let paramIndex = cargoParams.length + 1;

          if (busca) {
            conditions.push(
              `(c.nome ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.cpf ILIKE $${paramIndex})`
            );
            params.push(`%${busca}%`);
            paramIndex++;
          }

          if (departamentoId) {
            conditions.push(`c.departamento_id = $${paramIndex}`);
            params.push(parseInt(departamentoId));
            paramIndex++;
          }

          if (status) {
            conditions.push(`c.status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
          }

          const whereClause = `WHERE ${conditions.join(' AND ')}`;

          const countResult = await query(
            `SELECT COUNT(*) as total
             FROM people.colaboradores c
             INNER JOIN people.cargos cg ON c.cargo_id = cg.id
             ${whereClause}`,
            params
          );
          const total = parseInt(countResult.rows[0].total);

          const dataParams = [...params, limite, offset];
          const result = await query(
            `SELECT
              c.id,
              c.nome,
              c.email,
              c.cpf,
              c.tipo,
              c.cargo_id,
              cg.nome as cargo_nome,
              c.status,
              c.foto_url,
              c.data_admissao,
              c.empresa_id,
              d.id as departamento_id,
              d.nome as departamento_nome,
              e.nome_fantasia as empresa_nome_fantasia
            FROM people.colaboradores c
            INNER JOIN people.cargos cg ON c.cargo_id = cg.id
            LEFT JOIN people.departamentos d ON c.departamento_id = d.id
            LEFT JOIN people.empresas e ON c.empresa_id = e.id
            ${whereClause}
            ORDER BY c.${orderBy} ${orderDir}
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            dataParams
          );

          const dados = result.rows.map((row) => ({
            id: row.id,
            nome: row.nome,
            email: row.email,
            cpf: row.cpf,
            empresa: row.empresa_id
              ? { id: row.empresa_id, nomeFantasia: row.empresa_nome_fantasia }
              : null,
            departamento: row.departamento_id
              ? { id: row.departamento_id, nome: row.departamento_nome }
              : null,
            cargo: row.cargo_id
              ? { id: row.cargo_id, nome: row.cargo_nome }
              : null,
            tipo: row.tipo ?? 'colaborador',
            dataAdmissao: row.data_admissao,
            status: row.status,
            foto: row.foto_url,
          }));

          return { dados, total, pagina, limite };
        },
        CACHE_TTL.SHORT
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'visualizar',
          modulo: 'usuarios',
          descricao: 'Listagem de supervisores',
        })
      );

      return paginatedSuccessResponse(
        resultado.dados,
        resultado.total,
        resultado.pagina,
        resultado.limite
      );
    } catch (error) {
      console.error('Erro ao listar supervisores:', error);
      return serverErrorResponse('Erro ao listar supervisores');
    }
  });
}
