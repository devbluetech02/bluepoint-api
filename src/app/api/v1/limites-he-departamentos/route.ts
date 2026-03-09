import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { limitesHeDepartamentosSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLimitesHeDepartamentosCache, cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// =====================================================
// GET - Listar limites de departamentos de uma empresa
// =====================================================
export async function GET(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const empresaIdStr = searchParams.get('empresa_id');

      if (!empresaIdStr) {
        return errorResponse('Parâmetro empresa_id é obrigatório', 400);
      }

      const empresaId = parseInt(empresaIdStr);
      if (isNaN(empresaId)) {
        return errorResponse('empresa_id deve ser um número válido', 400);
      }

      const cacheKey = `${CACHE_KEYS.LIMITES_HE_DEPARTAMENTOS}list:${empresaId}`;

      const dados = await cacheAside(
        cacheKey,
        async () => {
          const limitesResult = await query(
            `SELECT l.id, l.empresa_id, l.departamento_id,
                    d.nome AS departamento_nome,
                    l.limite_mensal, l.created_at, l.updated_at
             FROM bluepoint.bt_limites_he_departamentos l
             JOIN bluepoint.bt_departamentos d ON l.departamento_id = d.id
             WHERE l.empresa_id = $1
             ORDER BY d.nome ASC`,
            [empresaId]
          );

          return Promise.all(limitesResult.rows.map(async (row) => {
            const limiteMensal = parseFloat(row.limite_mensal);

            const acumuladoResult = await query(
              `SELECT
                 COALESCE(SUM((s.dados_adicionais->>'custo_aprovado')::numeric), 0) AS total,
                 COUNT(*)::int AS qtd
               FROM bluepoint.bt_solicitacoes s
               JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id
               WHERE s.tipo = 'hora_extra'
                 AND s.status = 'aprovada'
                 AND c.departamento_id = $1
                 AND EXTRACT(MONTH FROM s.data_aprovacao) = EXTRACT(MONTH FROM CURRENT_DATE)
                 AND EXTRACT(YEAR FROM s.data_aprovacao) = EXTRACT(YEAR FROM CURRENT_DATE)`,
              [row.departamento_id]
            );

            const acumuladoMes = parseFloat(parseFloat(acumuladoResult.rows[0].total).toFixed(2));
            const totalAprovacoesMes = acumuladoResult.rows[0].qtd;

            return {
              id: row.id,
              empresa_id: row.empresa_id,
              departamento_id: row.departamento_id,
              departamento_nome: row.departamento_nome,
              limite_mensal: limiteMensal,
              acumulado_mes: acumuladoMes,
              saldo_disponivel: parseFloat(Math.max(0, limiteMensal - acumuladoMes).toFixed(2)),
              total_aprovacoes_mes: totalAprovacoesMes,
              created_at: row.created_at,
              updated_at: row.updated_at,
            };
          }));
        },
        CACHE_TTL.SHORT
      );

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar limites de HE por departamento:', error);
      return serverErrorResponse('Erro ao listar limites de horas extras por departamento');
    }
  });
}

// =====================================================
// POST - Criar ou atualizar limite de um departamento (UPSERT)
// =====================================================
export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(limitesHeDepartamentosSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { empresa_id, departamento_id, limite_mensal } = validation.data;

      const empresaResult = await query(
        `SELECT id FROM bluepoint.bt_empresas WHERE id = $1`,
        [empresa_id]
      );
      if (empresaResult.rows.length === 0) {
        return errorResponse('Empresa não encontrada', 404);
      }

      const deptResult = await query(
        `SELECT id, nome FROM bluepoint.bt_departamentos WHERE id = $1`,
        [departamento_id]
      );
      if (deptResult.rows.length === 0) {
        return errorResponse('Departamento não encontrado', 404);
      }

      const departamentoNome = deptResult.rows[0].nome;

      const result = await query(
        `INSERT INTO bluepoint.bt_limites_he_departamentos (empresa_id, departamento_id, limite_mensal)
         VALUES ($1, $2, $3)
         ON CONFLICT (empresa_id, departamento_id) DO UPDATE SET
           limite_mensal = $3,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [empresa_id, departamento_id, limite_mensal]
      );

      await invalidateLimitesHeDepartamentosCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'limites_he_departamentos',
        descricao: `Limite de HE do departamento "${departamentoNome}" definido: R$ ${limite_mensal.toFixed(2)}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { empresa_id, departamento_id, limite_mensal },
      });

      return successResponse({
        ...result.rows[0],
        departamento_nome: departamentoNome,
        message: 'Limite do departamento salvo com sucesso',
      });
    } catch (error) {
      console.error('Erro ao salvar limite de HE por departamento:', error);
      return serverErrorResponse('Erro ao salvar limite de horas extras do departamento');
    }
  });
}
