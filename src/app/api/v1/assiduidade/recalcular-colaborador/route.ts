import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import {
  calcularCadeiaColaborador,
  obterParametrosAssiduidade,
  isCargoExcluido,
  type ColaboradorParaCalculo,
} from '@/lib/assiduidade';
import { criarBuscadorPontos } from '@/lib/ocorrencias-externas';

/**
 * POST /api/v1/assiduidade/recalcular-colaborador
 *
 * Body: { colaborador_id, mes, ano }
 *
 * Remove o registro do colaborador para o mês/ano informado (e meses
 * posteriores, para manter a integridade da cadeia) e recalcula
 * a cadeia cronológica completa até o mês-alvo.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = await req.json().catch(() => ({}));
      const colaboradorId = parseInt(body.colaborador_id ?? '', 10);
      const mes = parseInt(body.mes ?? '', 10);
      const ano = parseInt(body.ano ?? '', 10);

      if (!colaboradorId || isNaN(colaboradorId)) {
        return errorResponse('colaborador_id obrigatório e numérico', 400);
      }
      if (!mes || !ano || mes < 1 || mes > 12 || ano < 2020 || ano > 2100) {
        return errorResponse('mes e ano obrigatórios e válidos', 400);
      }

      const colResult = await query(
        `SELECT c.id, c.nome, c.data_admissao, c.bloqueado_assiduidade,
                cg.nome AS cargo_nome, d.nome AS departamento_nome
         FROM bluepoint.bt_colaboradores c
         LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
         LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
         WHERE c.id = $1`,
        [colaboradorId],
      );

      if (colResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      const params = await obterParametrosAssiduidade();

      if (!params.ativo) {
        return errorResponse('Sistema de assiduidade esta desativado nos parametros', 400);
      }

      const row = colResult.rows[0];
      const colaborador: ColaboradorParaCalculo = {
        id: row.id,
        nome: row.nome,
        cargo_nome: row.cargo_nome ?? null,
        departamento_nome: row.departamento_nome ?? null,
        data_admissao: row.data_admissao as string,
        bloqueado: !!row.bloqueado_assiduidade,
        excluido: isCargoExcluido(row.cargo_nome ?? null, params.cargosExcluidos),
      };

      const client = await getClient();
      try {
        const clientQuery = client.query.bind(client);

        await clientQuery(
          `DELETE FROM bluepoint.bt_historico_assiduidade
           WHERE colaborador_id = $1
             AND (ano > $3 OR (ano = $3 AND mes >= $2))`,
          [colaboradorId, mes, ano],
        );

        const buscarPontos = criarBuscadorPontos();

        const resultado = await calcularCadeiaColaborador(
          clientQuery, colaborador, mes, ano, buscarPontos, params,
        );

        return successResponse({
          mensagem: 'Recálculo realizado com sucesso',
          ...resultado,
        });
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao recalcular assiduidade:', e);
      return serverErrorResponse('Erro ao recalcular assiduidade do colaborador');
    }
  });
}
