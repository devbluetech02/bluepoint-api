import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { limitesHeEmpresasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLimitesHeEmpresasCache, cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// =====================================================
// GET - Listar empresas com seus limites de HE
// =====================================================
export async function GET(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      const cacheKey = `${CACHE_KEYS.LIMITES_HE_EMPRESAS}list`;

      const dados = await cacheAside(
        cacheKey,
        async () => {
          const limitesResult = await query(
            `SELECT l.id, l.empresa_id, e.nome_fantasia AS empresa_nome,
                    l.limite_mensal, l.created_at, l.updated_at
             FROM bluepoint.bt_limites_he_empresas l
             JOIN bluepoint.bt_empresas e ON l.empresa_id = e.id
             ORDER BY e.nome_fantasia ASC`
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
                 AND c.empresa_id = $1
                 AND EXTRACT(MONTH FROM s.data_aprovacao) = EXTRACT(MONTH FROM CURRENT_DATE)
                 AND EXTRACT(YEAR FROM s.data_aprovacao) = EXTRACT(YEAR FROM CURRENT_DATE)`,
              [row.empresa_id]
            );

            const acumuladoMes = parseFloat(parseFloat(acumuladoResult.rows[0].total).toFixed(2));
            const totalAprovacoesMes = acumuladoResult.rows[0].qtd;

            return {
              id: row.id,
              empresa_id: row.empresa_id,
              empresa_nome: row.empresa_nome,
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
      console.error('Erro ao listar limites de HE por empresa:', error);
      return serverErrorResponse('Erro ao listar limites de horas extras por empresa');
    }
  });
}

// =====================================================
// POST - Criar ou atualizar limite de uma empresa (UPSERT)
// =====================================================
export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(limitesHeEmpresasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { empresa_id, limite_mensal } = validation.data;

      const empresaResult = await query(
        `SELECT id, nome_fantasia FROM bluepoint.bt_empresas WHERE id = $1`,
        [empresa_id]
      );

      if (empresaResult.rows.length === 0) {
        return errorResponse('Empresa não encontrada', 404);
      }

      const empresaNome = empresaResult.rows[0].nome_fantasia;

      const result = await query(
        `INSERT INTO bluepoint.bt_limites_he_empresas (empresa_id, limite_mensal)
         VALUES ($1, $2)
         ON CONFLICT (empresa_id) DO UPDATE SET
           limite_mensal = $2,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [empresa_id, limite_mensal]
      );

      await invalidateLimitesHeEmpresasCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'limites_he_empresas',
        descricao: `Limite de HE da empresa "${empresaNome}" definido: R$ ${limite_mensal.toFixed(2)}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { empresa_id, limite_mensal },
      });

      return successResponse({
        ...result.rows[0],
        empresa_nome: empresaNome,
        message: 'Limite da empresa salvo com sucesso',
      });
    } catch (error) {
      console.error('Erro ao salvar limite de HE por empresa:', error);
      return serverErrorResponse('Erro ao salvar limite de horas extras da empresa');
    }
  });
}
