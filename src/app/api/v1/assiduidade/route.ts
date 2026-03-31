import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import {
  calcularDiasTrabalhados,
  calcularValorBonus,
  obterParametrosAssiduidade,
  isCargoExcluido,
} from '@/lib/assiduidade';
import { buscarPontosMes } from '@/lib/ocorrencias-externas';

/**
 * GET /api/v1/assiduidade?mes=1&ano=2025
 *
 * Preview em tempo real (sem persistencia).
 * Busca pontos na API externa do Portal do Colaborador e calcula
 * o bonus de todos os colaboradores ativos para o mes/ano informado.
 * Usa o valor do mes anterior ja persistido em historico_assiduidade.
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const mes = parseInt(searchParams.get('mes') ?? '', 10);
      const ano = parseInt(searchParams.get('ano') ?? '', 10);

      if (!mes || !ano || mes < 1 || mes > 12 || ano < 2020 || ano > 2100) {
        return errorResponse(
          'Parametros mes e ano obrigatorios e validos (mes 1-12, ano 2020-2100)',
          400,
        );
      }

      const [colaboradoresResult, pontosMap, params] = await Promise.all([
        query(
          `SELECT c.id, c.nome, c.data_admissao, c.bloqueado_assiduidade,
                  cg.nome AS cargo_nome, d.nome AS departamento_nome
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
           LEFT JOIN people.departamentos d ON c.departamento_id = d.id
           WHERE c.status = 'ativo'`,
        ),
        buscarPontosMes(mes, ano),
        obterParametrosAssiduidade(),
      ]);

      if (!params.ativo) {
        return successResponse({ mes, ano, total: 0, registros: [], inativo: true });
      }

      const registros: Record<string, unknown>[] = [];

      for (const col of colaboradoresResult.rows) {
        const bloqueado = !!col.bloqueado_assiduidade;
        const excluido = isCargoExcluido(col.cargo_nome ?? null, params.cargosExcluidos);
        const dataAdmissao = col.data_admissao as string;
        const diasTrabalhados = calcularDiasTrabalhados(dataAdmissao, mes, ano);
        const admitidoNesteMes =
          dataAdmissao.slice(0, 7) === `${ano}-${String(mes).padStart(2, '0')}`;

        const pontos = pontosMap.get(col.id) ?? { total_pontos: 0, ocorrencias_periodo: 0 };

        let valorMesAnterior = 0;
        if (!admitidoNesteMes) {
          const mesAnt = mes === 1 ? 12 : mes - 1;
          const anoAnt = mes === 1 ? ano - 1 : ano;
          const ant = await query(
            `SELECT valor_total FROM people.historico_assiduidade
             WHERE colaborador_id = $1 AND mes = $2 AND ano = $3`,
            [col.id, mesAnt, anoAnt],
          );
          valorMesAnterior = ant.rows[0] ? Number(ant.rows[0].valor_total) : 0;
        }

        const { valor, motivo } = calcularValorBonus(
          pontos.total_pontos, valorMesAnterior, diasTrabalhados,
          admitidoNesteMes, excluido, bloqueado, params,
        );

        registros.push({
          colaborador_id: col.id,
          colaborador_nome: col.nome,
          cargo_nome: col.cargo_nome,
          departamento_nome: col.departamento_nome,
          total_pontos: pontos.total_pontos,
          ocorrencias_periodo: pontos.ocorrencias_periodo,
          dias_trabalhados: diasTrabalhados,
          valor_total: valor,
          observacoes: motivo,
        });
      }

      return successResponse({ mes, ano, total: registros.length, registros });
    } catch (e) {
      console.error('Erro no calculo em tempo real de assiduidade:', e);
      return serverErrorResponse('Erro no calculo de assiduidade');
    }
  });
}
