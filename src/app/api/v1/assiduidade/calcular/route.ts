import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import {
  calcularCadeiaColaborador,
  obterParametrosAssiduidade,
  isCargoExcluido,
  type ColaboradorParaCalculo,
  type ResultadoCalculo,
} from '@/lib/assiduidade';
import { buscarPontosMes, criarBuscadorPontos } from '@/lib/ocorrencias-externas';

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;

/**
 * GET /api/v1/assiduidade/calcular?mes=X&ano=Y
 *
 * Retorna registros ja calculados + contagem de pendentes.
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

      const now = new Date();
      if (
        ano > now.getFullYear() ||
        (ano === now.getFullYear() && mes > now.getMonth() + 1)
      ) {
        return errorResponse('Nao e permitido consulta para mes futuro', 400);
      }

      const [registrosResult, pendentesResult] = await Promise.all([
        query(
          `SELECT id, colaborador_id, mes, ano, total_pontos, valor_ponto,
                  valor_base, valor_bonus, valor_total, dias_trabalhados,
                  ocorrencias_periodo, pontuacao_ocorrencias,
                  colaborador_nome, colaborador_cargo,
                  colaborador_departamento, observacoes,
                  status, calculado_em, atualizado_em
           FROM people.historico_assiduidade
           WHERE mes = $1 AND ano = $2
           ORDER BY colaborador_nome`,
          [mes, ano],
        ),
        query(
          `SELECT COUNT(*)::int AS total
           FROM people.colaboradores c
           WHERE c.status = 'ativo'
             AND NOT EXISTS (
               SELECT 1 FROM people.historico_assiduidade h
               WHERE h.colaborador_id = c.id AND h.mes = $1 AND h.ano = $2
             )`,
          [mes, ano],
        ),
      ]);

      return successResponse({
        mes,
        ano,
        registros: registrosResult.rows,
        total: registrosResult.rows.length,
        pendentes: Number(pendentesResult.rows[0]?.total ?? 0),
      });
    } catch (e) {
      console.error('Erro ao buscar historico de assiduidade:', e);
      return serverErrorResponse('Erro ao buscar historico de assiduidade');
    }
  });
}

/**
 * POST /api/v1/assiduidade/calcular
 *
 * Body: { mes, ano, batchSize?, forcarRecalculo? }
 *
 * Busca ocorrencias automaticamente na API externa do Portal do Colaborador,
 * calcula um lote de colaboradores pendentes com cadeia cronologica.
 * Quando forcarRecalculo=true, remove todos os registros do mes
 * para que todos voltem a ser "pendentes".
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = await req.json().catch(() => ({}));
      const mes = parseInt(body.mes ?? '', 10);
      const ano = parseInt(body.ano ?? '', 10);
      const batchSize = Math.min(
        MAX_BATCH_SIZE,
        Math.max(1, parseInt(body.batchSize ?? '', 10) || DEFAULT_BATCH_SIZE),
      );
      const forcarRecalculo = !!body.forcarRecalculo;

      if (!mes || !ano || mes < 1 || mes > 12 || ano < 2020 || ano > 2100) {
        return errorResponse(
          'Body deve conter mes e ano validos (mes 1-12, ano 2020-2100)',
          400,
        );
      }

      const now = new Date();
      if (
        ano > now.getFullYear() ||
        (ano === now.getFullYear() && mes > now.getMonth() + 1)
      ) {
        return errorResponse('Nao e permitido calculo para mes futuro', 400);
      }

      const params = await obterParametrosAssiduidade();

      if (!params.ativo) {
        return errorResponse('Sistema de assiduidade esta desativado nos parametros', 400);
      }

      const client = await getClient();
      try {
        const clientQuery = client.query.bind(client);

        if (forcarRecalculo) {
          await clientQuery(
            `DELETE FROM people.historico_assiduidade
             WHERE mes = $1 AND ano = $2
               AND colaborador_id IN (
                 SELECT id FROM people.colaboradores
                 WHERE status = 'ativo'
               )`,
            [mes, ano],
          );
        }

        const pendentes = await clientQuery(
          `SELECT c.id, c.nome, c.data_admissao,
                  c.bloqueado_assiduidade,
                  cg.nome AS cargo_nome,
                  d.nome AS departamento_nome
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
           LEFT JOIN people.departamentos d
             ON c.departamento_id = d.id
           WHERE c.status = 'ativo'
             AND NOT EXISTS (
               SELECT 1 FROM people.historico_assiduidade h
               WHERE h.colaborador_id = c.id
                 AND h.mes = $1 AND h.ano = $2
             )
           ORDER BY c.nome
           LIMIT $3`,
          [mes, ano, batchSize],
        );

        const totalPendentesResult = await clientQuery(
          `SELECT COUNT(*)::int AS total
           FROM people.colaboradores c
           WHERE c.status = 'ativo'
             AND NOT EXISTS (
               SELECT 1 FROM people.historico_assiduidade h
               WHERE h.colaborador_id = c.id
                 AND h.mes = $1 AND h.ano = $2
             )`,
          [mes, ano],
        );
        const totalPendentes = Number(
          totalPendentesResult.rows[0]?.total ?? 0,
        );

        const pontosPreCarregados = await buscarPontosMes(mes, ano);
        const buscarPontos = criarBuscadorPontos({
          pontosPreCarregados,
          mesPreCarregado: mes,
          anoPreCarregado: ano,
        });

        const registros: ResultadoCalculo[] = [];

        for (const row of pendentes.rows) {
          const colaborador: ColaboradorParaCalculo = {
            id: row.id,
            nome: row.nome,
            cargo_nome: row.cargo_nome ?? null,
            departamento_nome: row.departamento_nome ?? null,
            data_admissao: row.data_admissao as string,
            bloqueado: !!row.bloqueado_assiduidade,
            excluido: isCargoExcluido(row.cargo_nome ?? null, params.cargosExcluidos),
          };

          const resultado = await calcularCadeiaColaborador(
            clientQuery,
            colaborador,
            mes,
            ano,
            buscarPontos,
            params,
          );
          registros.push(resultado);
        }

        const pendentesRestantes = totalPendentes - registros.length;

        return successResponse({
          mes,
          ano,
          processados: registros.length,
          pendentes_restantes: Math.max(0, pendentesRestantes),
          forcar_recalculo: forcarRecalculo,
          registros,
        });
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Erro ao calcular assiduidade em batch:', e);
      return serverErrorResponse('Erro ao calcular assiduidade');
    }
  });
}
