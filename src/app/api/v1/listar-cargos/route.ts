import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const busca = searchParams.get('busca');
      // Quando empresaId é passado, salarioEfetivo/jornadaIdEfetiva refletem
      // overrides de people.cargos_uf pra UF dessa empresa. Sem empresaId, o
      // LEFT JOIN não casa e os efetivos caem nos padrões nacionais.
      const empresaIdRaw = searchParams.get('empresaId');
      const empresaId = empresaIdRaw ? parseInt(empresaIdRaw) : null;

      const cacheKey = `${CACHE_KEYS.CARGOS}list:${pagina}:${limite}:${busca || ''}:${empresaId ?? ''}`;

      // Usar cache-aside pattern
      const result = await cacheAside(
        cacheKey,
        async () => {
          const conditions: string[] = [];
          const params: unknown[] = [];
          let paramIndex = 1;

          // Filtro de busca por nome, CBO ou descrição
          if (busca) {
            conditions.push(
              `(LOWER(c.nome) LIKE $${paramIndex} OR LOWER(c.cbo) LIKE $${paramIndex} OR LOWER(c.descricao) LIKE $${paramIndex})`
            );
            params.push(`%${busca.toLowerCase()}%`);
            paramIndex++;
          }

          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

          // Contar total
          const countResult = await query(
            `SELECT COUNT(*) as total FROM people.cargos c ${whereClause}`,
            params
          );
          const total = parseInt(countResult.rows[0].total);

          // empresaId vai como último parâmetro pra alimentar a subquery do LEFT JOIN.
          // Se for null, a subquery devolve NULL e nenhuma linha de cargos_uf casa
          // (NULL = NULL é UNKNOWN no SQL), então salario_efetivo = salario_padrao.
          const dataParams = [...params, limite, offset, empresaId];
          const dataResult = await query(
            `SELECT c.id, c.nome, c.cbo, c.descricao, c.salario_padrao,
                    c.jornada_id_padrao, c.templates_contrato_admissao,
                    c.template_dia_teste, c.nivel_acesso_id, c.created_at, c.updated_at,
                    COALESCE(cu.salario,    c.salario_padrao)    AS salario_efetivo,
                    COALESCE(cu.jornada_id, c.jornada_id_padrao) AS jornada_id_efetiva
             FROM people.cargos c
             LEFT JOIN people.cargos_uf cu
               ON cu.cargo_id = c.id
              AND cu.uf = (SELECT estado FROM people.empresas WHERE id = $${paramIndex + 2} LIMIT 1)
             ${whereClause}
             ORDER BY c.nome ASC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            dataParams
          );

          const cargoIds = dataResult.rows.map((c) => c.id as number);
          const examesPorCargo = new Map<number, { id: number; nome: string }[]>();

          if (cargoIds.length > 0) {
            const examesResult = await query(
              `SELECT ce.cargo_id, e.id, e.nome
               FROM people.cargos_exames ce
               JOIN people.exames e ON e.id = ce.exame_id
               WHERE ce.cargo_id = ANY($1::int[])
               ORDER BY e.nome ASC`,
              [cargoIds]
            );
            for (const row of examesResult.rows as { cargo_id: number; id: number; nome: string }[]) {
              const lista = examesPorCargo.get(row.cargo_id) ?? [];
              lista.push({ id: row.id, nome: row.nome });
              examesPorCargo.set(row.cargo_id, lista);
            }
          }

          const dados = dataResult.rows.map(cargo => ({
            id: cargo.id,
            nome: cargo.nome,
            cbo: cargo.cbo,
            descricao: cargo.descricao,
            salarioPadrao: cargo.salario_padrao ? parseFloat(cargo.salario_padrao) : null,
            jornadaIdPadrao: cargo.jornada_id_padrao ?? null,
            salarioEfetivo: cargo.salario_efetivo ? parseFloat(cargo.salario_efetivo) : null,
            jornadaIdEfetiva: cargo.jornada_id_efetiva ?? null,
            templatesContratoAdmissao: cargo.templates_contrato_admissao ?? [],
            templateDiaTeste: cargo.template_dia_teste ?? null,
            nivelAcessoId: cargo.nivel_acesso_id ?? null,
            exames: examesPorCargo.get(cargo.id) ?? [],
            criadoEm: cargo.created_at,
            atualizadoEm: cargo.updated_at,
          }));

          return buildPaginatedResponse(dados, total, pagina, limite);
        },
        CACHE_TTL.LONG // Cargos raramente mudam - cache de 1 hora
      );

      return successResponse(result);
    } catch (error) {
      console.error('Erro ao listar cargos:', error);
      return serverErrorResponse('Erro ao listar cargos');
    }
  });
}
