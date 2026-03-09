import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  getPaginationParams,
  buildPaginatedResponse,
} from '@/lib/api-response';
import { withApiAuth, getAuthInfo } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateSolicitacoesHorasExtrasCache } from '@/lib/cache';
import {
  calcularCustoHoraExtra,
  salvarCustoHoraExtra,
  calcularHorasDecimais,
} from '@/lib/custoHorasExtrasService';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// =====================================================
// GET - Listar solicitações (API externa)
// =====================================================
export async function GET(request: NextRequest) {
  return withApiAuth(
    request,
    async (req, auth) => {
      try {
        const { searchParams } = new URL(req.url);
        const { pagina, limite, offset } = getPaginationParams(searchParams);

        const clampedLimite = Math.min(limite, 200);
        const clampedOffset = (pagina - 1) * clampedLimite;

        const colaboradorId = searchParams.get('colaborador_id');
        const solicitante = searchParams.get('solicitante');
        const gestor = searchParams.get('gestor');
        const dataInicio = searchParams.get('data_inicio');
        const dataFim = searchParams.get('data_fim');
        const status = searchParams.get('status');

        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (colaboradorId) {
          conditions.push(`s.colaborador_id = $${paramIndex}`);
          params.push(parseInt(colaboradorId));
          paramIndex++;
        }

        if (solicitante) {
          conditions.push(`s.solicitante ILIKE $${paramIndex}`);
          params.push(`%${solicitante}%`);
          paramIndex++;
        }

        if (gestor) {
          conditions.push(`s.gestor ILIKE $${paramIndex}`);
          params.push(`%${gestor}%`);
          paramIndex++;
        }

        if (dataInicio) {
          conditions.push(`s.data >= $${paramIndex}`);
          params.push(dataInicio);
          paramIndex++;
        }

        if (dataFim) {
          conditions.push(`s.data <= $${paramIndex}`);
          params.push(dataFim);
          paramIndex++;
        }

        if (status) {
          conditions.push(`s.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) as total FROM bluepoint.bt_solicitacoes_horas_extras s ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        const dataParams = [...params, clampedLimite, clampedOffset];
        const result = await query(
          `SELECT s.*, cg.nome AS cargo, e.nome_fantasia AS filial
           FROM bluepoint.bt_solicitacoes_horas_extras s
           LEFT JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id
           LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
           LEFT JOIN bluepoint.bt_empresas e ON c.empresa_id = e.id
           ${whereClause}
           ORDER BY s.criado_em DESC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        // Buscar custos em lote
        const ids = result.rows.map((r) => r.id);
        let custosMap = new Map();
        if (ids.length > 0) {
          const custosResult = await query(
            `SELECT solicitacao_id, horas_extras, custo_dia, custo_mes, custo_ano
             FROM bluepoint.bt_custo_horas_extras
             WHERE solicitacao_id = ANY($1)`,
            [ids]
          );
          custosMap = new Map(custosResult.rows.map((c) => [c.solicitacao_id, c]));
        }

        const dados = result.rows.map((row) => {
          const custo = custosMap.get(row.id);
          return {
            ...row,
            horas_extras: custo ? parseFloat(custo.horas_extras) : null,
            custo_dia: custo ? parseFloat(custo.custo_dia) : null,
            custo_mes: custo ? parseFloat(custo.custo_mes) : null,
            custo_ano: custo ? parseFloat(custo.custo_ano) : null,
          };
        });

        const response = buildPaginatedResponse(dados, total, pagina, clampedLimite);

        return NextResponse.json(response, { headers: CORS_HEADERS });
      } catch (error) {
        console.error('Erro ao listar solicitações HE (externo):', error);
        return serverErrorResponse('Erro ao listar solicitações de horas extras');
      }
    },
    { modulo: 'horas_extras', permissaoMinima: 'read' }
  );
}

// =====================================================
// POST - Criar solicitação (API externa)
// =====================================================
export async function POST(request: NextRequest) {
  return withApiAuth(
    request,
    async (req, auth) => {
      try {
        const body = await req.json();

        const { solicitante, gestor, data, de, ate, colaborador_id, matricula } = body;

        if (!solicitante || !data || !de || !ate) {
          return errorResponse('Campos obrigatórios: solicitante, data, de, ate');
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
          return errorResponse('Data deve estar no formato YYYY-MM-DD');
        }

        const horaRegex = /^\d{2}:\d{2}$/;
        const horaDe = de.includes('T') ? de.split('T')[1].substring(0, 5) : de;
        const horaAte = ate.includes('T') ? ate.split('T')[1].substring(0, 5) : ate;

        if (!horaRegex.test(horaDe) || !horaRegex.test(horaAte)) {
          return errorResponse('Horários devem estar no formato HH:MM');
        }

        // Resolver colaborador_id a partir da matricula (cpf) se necessário
        let resolvedColaboradorId = colaborador_id || null;

        if (!resolvedColaboradorId && matricula) {
          const colabResult = await query(
            `SELECT id FROM bluepoint.bt_colaboradores WHERE cpf = $1 AND status = 'ativo'`,
            [matricula]
          );
          if (colabResult.rows.length > 0) {
            resolvedColaboradorId = colabResult.rows[0].id;
          }
        }

        // Inserir solicitação
        const insertResult = await query(
          `INSERT INTO bluepoint.bt_solicitacoes_horas_extras
             (solicitante, gestor, data, de, ate, colaborador_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pendente')
           RETURNING *`,
          [solicitante, gestor || '', data, horaDe, horaAte, resolvedColaboradorId]
        );

        const solicitacao = insertResult.rows[0];

        let custoData = null;

        if (resolvedColaboradorId) {
          const custos = await calcularCustoHoraExtra(resolvedColaboradorId, horaDe, horaAte);
          if (custos) {
            await salvarCustoHoraExtra(
              solicitacao.id,
              resolvedColaboradorId,
              custos.cargo_id,
              custos.empresa_id,
              custos
            );
            custoData = custos;
          }
        }

        await invalidateSolicitacoesHorasExtrasCache();

        const authInfo = getAuthInfo(auth);
        await registrarAuditoria({
          usuarioId: typeof authInfo.id === 'number' ? authInfo.id : null,
          acao: 'criar',
          modulo: 'custos_horas_extras',
          descricao: `[API Externa] Solicitação HE criada: ${solicitante} em ${data} (${horaDe}-${horaAte})`,
          ip: getClientIp(request),
          userAgent: getUserAgent(request),
          dadosNovos: { solicitacaoId: solicitacao.id, solicitante, data },
        });

        const horasExtras = calcularHorasDecimais(horaDe, horaAte);

        return NextResponse.json(
          {
            success: true,
            data: {
              ...solicitacao,
              cargo: custoData?.cargo || null,
              filial: custoData?.empresa || null,
              horas_extras: horasExtras,
              custo_dia: custoData?.custo_dia || null,
              custo_mes: custoData?.custo_mes || null,
              custo_ano: custoData?.custo_ano || null,
              valor_he_base: custoData?.valor_he_base || null,
              valor_dsr: custoData?.valor_dsr || null,
              valor_13: custoData?.valor_13 || null,
              valor_ferias: custoData?.valor_ferias || null,
              um_terco_ferias: custoData?.um_terco_ferias || null,
              valor_fgts: custoData?.valor_fgts || null,
              valor_inss: custoData?.valor_inss || null,
            },
            message: 'Solicitação de horas extras criada com sucesso',
          },
          { headers: CORS_HEADERS }
        );
      } catch (error) {
        console.error('Erro ao criar solicitação HE (externo):', error);
        return serverErrorResponse('Erro ao criar solicitação de horas extras');
      }
    },
    { modulo: 'horas_extras', permissaoMinima: 'write' }
  );
}
