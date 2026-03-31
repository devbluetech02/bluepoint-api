import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  serverErrorResponse,
  getPaginationParams,
  buildPaginatedResponse,
} from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// =====================================================
// GET - Listar horas extras consolidadas (por mês/ano)
// =====================================================
export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const search = searchParams.get('search');
      const colaboradorId = searchParams.get('colaborador_id');
      const empresaId = searchParams.get('filial_id') || searchParams.get('empresa_id');
      const cargoId = searchParams.get('cargo_id');
      const mes = searchParams.get('mes');
      const ano = searchParams.get('ano');

      const cacheKey = buildListCacheKey(CACHE_KEYS.HORAS_EXTRAS_CONSOLIDADO, {
        pagina, limite, search, colaboradorId, empresaId, cargoId, mes, ano,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (search) {
          conditions.push(`c.nome ILIKE $${paramIndex}`);
          params.push(`%${search}%`);
          paramIndex++;
        }

        if (colaboradorId) {
          conditions.push(`h.colaborador_id = $${paramIndex}`);
          params.push(parseInt(colaboradorId));
          paramIndex++;
        }

        if (empresaId) {
          conditions.push(`h.empresa_id = $${paramIndex}`);
          params.push(parseInt(empresaId));
          paramIndex++;
        }

        if (cargoId) {
          conditions.push(`h.cargo_id = $${paramIndex}`);
          params.push(parseInt(cargoId));
          paramIndex++;
        }

        if (mes) {
          conditions.push(`h.mes = $${paramIndex}`);
          params.push(parseInt(mes));
          paramIndex++;
        }

        if (ano) {
          conditions.push(`h.ano = $${paramIndex}`);
          params.push(parseInt(ano));
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) as total
           FROM people.horas_extras_consolidado h
           JOIN people.colaboradores c ON h.colaborador_id = c.id
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT
             h.id,
             h.colaborador_id,
             c.nome AS colaborador_nome,
             c.cpf AS colaborador_matricula,
             h.cargo_id,
             cg.nome AS cargo_nome,
             h.empresa_id,
             e.nome_fantasia AS empresa_nome,
             h.mes, h.ano,
             h.horas_extras, h.valor_he_base, h.valor_dsr,
             h.valor_13, h.valor_ferias, h.valor_encarreg,
             h.custo_mes, h.custo_ano, h.observacao
           FROM people.horas_extras_consolidado h
           JOIN people.colaboradores c ON h.colaborador_id = c.id
           LEFT JOIN people.cargos cg ON h.cargo_id = cg.id
           LEFT JOIN people.empresas e ON h.empresa_id = e.id
           ${whereClause}
           ORDER BY h.ano DESC, h.mes DESC, c.nome ASC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map((row) => ({
          id: row.id,
          colaborador: {
            id: row.colaborador_id,
            nome: row.colaborador_nome,
            matricula: row.colaborador_matricula,
          },
          cargo: {
            id: row.cargo_id,
            nome: row.cargo_nome,
          },
          filial: {
            id: row.empresa_id,
            nome: row.empresa_nome,
          },
          periodo: {
            mes: row.mes,
            ano: row.ano,
          },
          valores: {
            horas_extras: parseFloat(row.horas_extras),
            valor_he_base: parseFloat(row.valor_he_base),
            valor_dsr: parseFloat(row.valor_dsr),
            valor_13: parseFloat(row.valor_13),
            valor_ferias: parseFloat(row.valor_ferias),
            valor_encarreg: parseFloat(row.valor_encarreg),
            custo_mes: parseFloat(row.custo_mes),
            custo_ano: parseFloat(row.custo_ano),
          },
          observacao: row.observacao,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      const response = buildPaginatedResponse(
        resultado.dados,
        resultado.total,
        resultado.pagina,
        resultado.limite
      );

      return successResponse(response);
    } catch (error) {
      console.error('Erro ao listar horas extras consolidadas:', error);
      return serverErrorResponse('Erro ao listar horas extras consolidadas');
    }
  });
}
