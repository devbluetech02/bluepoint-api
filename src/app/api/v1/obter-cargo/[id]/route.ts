import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      // Quando empresaId é passado, salarioEfetivo/jornadaIdEfetiva refletem
      // overrides de people.cargos_uf pra UF dessa empresa. Sem empresaId,
      // os efetivos caem nos padrões nacionais via COALESCE.
      const { searchParams } = new URL(request.url);
      const empresaIdRaw = searchParams.get('empresaId');
      const empresaId = empresaIdRaw ? parseInt(empresaIdRaw) : null;

      const cacheKey = `${CACHE_KEYS.CARGO}${cargoId}:${empresaId ?? ''}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT c.id, c.nome, c.cbo, c.descricao, c.salario_padrao,
                c.jornada_id_padrao, c.templates_contrato_admissao,
                c.template_dia_teste, c.nivel_acesso_id, c.created_at, c.updated_at,
                COALESCE(cu.salario,    c.salario_padrao)    AS salario_efetivo,
                COALESCE(cu.jornada_id, c.jornada_id_padrao) AS jornada_id_efetiva
         FROM people.cargos c
         LEFT JOIN people.cargos_uf cu
           ON cu.cargo_id = c.id
          AND cu.uf = (SELECT estado FROM people.empresas WHERE id = $2 LIMIT 1)
         WHERE c.id = $1`,
        [cargoId, empresaId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const cargo = result.rows[0];

      const examesResult = await query(
        `SELECT e.id, e.nome
         FROM people.cargos_exames ce
         JOIN people.exames e ON e.id = ce.exame_id
         WHERE ce.cargo_id = $1
         ORDER BY e.nome ASC`,
        [cargoId]
      );
      const exames = (examesResult.rows as { id: number; nome: string }[]).map((r) => ({
        id: r.id,
        nome: r.nome,
      }));

      return {
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
        exames,
        criadoEm: cargo.created_at,
        atualizadoEm: cargo.updated_at,
      };
      }, CACHE_TTL.LONG);

      if (!dados) {
        return notFoundResponse('Cargo não encontrado');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter cargo:', error);
      return serverErrorResponse('Erro ao obter cargo');
    }
  });
}
