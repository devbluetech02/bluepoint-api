import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { parametrosAssiduidadeSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheAside, CACHE_KEYS, CACHE_TTL, invalidateParametrosAssiduidadeCache } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.PARAMETROS_ASSIDUIDADE}atual`;

      const resultado = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT p.id, p.limite_pontos_zerar, p.min_dias_admissao_mes,
                  p.valor_inicial, p.incremento_mensal, p.valor_maximo,
                  p.cargos_excluidos, p.ativo, p.atualizado_em, p.atualizado_por,
                  c.id AS usuario_id, c.nome AS usuario_nome
           FROM bluepoint.bt_parametros_assiduidade p
           LEFT JOIN bluepoint.bt_colaboradores c ON p.atualizado_por = c.id
           ORDER BY p.id DESC
           LIMIT 1`,
        );

        if (result.rows.length === 0) {
          return {
            id: null,
            limitePontosZerar: 3,
            minDiasAdmissaoMes: 15,
            valorInicial: 100,
            incrementoMensal: 100,
            valorMaximo: 300,
            cargosExcluidos: [
              'Supervisor de Estoque',
              'Supervisor de Operações',
              'Gestor de Operações',
              'Coordenador de Operações',
            ],
            ativo: true,
            atualizadoEm: null,
            atualizadoPor: null,
          };
        }

        const row = result.rows[0];

        return {
          id: row.id,
          limitePontosZerar: row.limite_pontos_zerar,
          minDiasAdmissaoMes: row.min_dias_admissao_mes,
          valorInicial: Number(row.valor_inicial),
          incrementoMensal: Number(row.incremento_mensal),
          valorMaximo: Number(row.valor_maximo),
          cargosExcluidos: row.cargos_excluidos ?? [],
          ativo: row.ativo,
          atualizadoEm: row.atualizado_em,
          atualizadoPor: row.atualizado_por
            ? { id: row.usuario_id, nome: row.usuario_nome }
            : null,
        };
      }, CACHE_TTL.LONG);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar parametros de assiduidade:', error);
      return serverErrorResponse('Erro ao buscar parametros de assiduidade');
    }
  });
}

export async function PUT(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(parametrosAssiduidadeSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const existeResult = await query(
        `SELECT id FROM bluepoint.bt_parametros_assiduidade ORDER BY id DESC LIMIT 1`,
      );

      let result;
      let acao: 'criar' | 'editar';

      if (existeResult.rows.length > 0) {
        const parametroId = existeResult.rows[0].id;
        acao = 'editar';

        result = await query(
          `UPDATE bluepoint.bt_parametros_assiduidade
           SET limite_pontos_zerar = $1,
               min_dias_admissao_mes = $2,
               valor_inicial = $3,
               incremento_mensal = $4,
               valor_maximo = $5,
               cargos_excluidos = $6::jsonb,
               ativo = $7,
               atualizado_por = $8
           WHERE id = $9
           RETURNING id, limite_pontos_zerar, min_dias_admissao_mes,
                     valor_inicial, incremento_mensal, valor_maximo,
                     cargos_excluidos, ativo, atualizado_em`,
          [
            data.limitePontosZerar,
            data.minDiasAdmissaoMes,
            data.valorInicial,
            data.incrementoMensal,
            data.valorMaximo,
            JSON.stringify(data.cargosExcluidos),
            data.ativo,
            user.userId,
            parametroId,
          ],
        );
      } else {
        acao = 'criar';

        result = await query(
          `INSERT INTO bluepoint.bt_parametros_assiduidade
             (limite_pontos_zerar, min_dias_admissao_mes,
              valor_inicial, incremento_mensal, valor_maximo,
              cargos_excluidos, ativo, atualizado_por)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING id, limite_pontos_zerar, min_dias_admissao_mes,
                     valor_inicial, incremento_mensal, valor_maximo,
                     cargos_excluidos, ativo, atualizado_em`,
          [
            data.limitePontosZerar,
            data.minDiasAdmissaoMes,
            data.valorInicial,
            data.incrementoMensal,
            data.valorMaximo,
            JSON.stringify(data.cargosExcluidos),
            data.ativo,
            user.userId,
          ],
        );
      }

      const row = result.rows[0];

      await invalidateParametrosAssiduidadeCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao,
        modulo: 'assiduidade',
        descricao: `Parametros de assiduidade ${acao === 'criar' ? 'criados' : 'atualizados'}: limite ${data.limitePontosZerar} pts, valor R$${data.valorInicial}-R$${data.valorMaximo}, ${data.ativo ? 'ativo' : 'inativo'}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: data,
      });

      return successResponse({
        id: row.id,
        limitePontosZerar: row.limite_pontos_zerar,
        minDiasAdmissaoMes: row.min_dias_admissao_mes,
        valorInicial: Number(row.valor_inicial),
        incrementoMensal: Number(row.incremento_mensal),
        valorMaximo: Number(row.valor_maximo),
        cargosExcluidos: row.cargos_excluidos ?? [],
        ativo: row.ativo,
        atualizadoEm: row.atualizado_em,
        atualizadoPor: { id: user.userId, nome: user.nome },
        mensagem: `Parametros de assiduidade ${acao === 'criar' ? 'criados' : 'atualizados'} com sucesso`,
      });
    } catch (error) {
      console.error('Erro ao atualizar parametros de assiduidade:', error);
      return serverErrorResponse('Erro ao atualizar parametros de assiduidade');
    }
  });
}
