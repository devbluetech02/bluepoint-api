import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withApiAuth } from '@/lib/middleware';
import { calcularCustoHoraExtra } from '@/lib/custoHorasExtrasService';

interface Params {
  params: Promise<{ id: string }>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// =====================================================
// GET - Custos detalhados de uma solicitação (externo)
// =====================================================
export async function GET(request: NextRequest, { params }: Params) {
  return withApiAuth(
    request,
    async () => {
      try {
        const { id } = await params;
        const solicitacaoId = parseInt(id);

        if (isNaN(solicitacaoId)) {
          return notFoundResponse('Solicitação não encontrada');
        }

        // Buscar dados da solicitação
        const solResult = await query(
          `SELECT s.*, cg.nome AS cargo, e.nome_fantasia AS filial
           FROM people.solicitacoes_horas_extras s
           LEFT JOIN people.colaboradores c ON s.colaborador_id = c.id
           LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
           LEFT JOIN people.empresas e ON c.empresa_id = e.id
           WHERE s.id = $1`,
          [solicitacaoId]
        );

        if (solResult.rows.length === 0) {
          return notFoundResponse('Solicitação não encontrada');
        }

        // Buscar custos detalhados
        const custoResult = await query(
          `SELECT horas_extras, valor_he_base, valor_dsr, valor_13, valor_ferias,
                  um_terco_ferias, valor_fgts, valor_inss, custo_dia, custo_mes, custo_ano
           FROM people.custo_horas_extras
           WHERE solicitacao_id = $1 OR solicitacao_original_id = $1
           LIMIT 1`,
          [solicitacaoId]
        );

        const solicitacao = solResult.rows[0];
        let custos = custoResult.rows.length > 0 ? custoResult.rows[0] : null;

        // Fallback: calcular em tempo real se não há custos pré-salvos
        if (!custos && solicitacao.colaborador_id) {
          const horaInicio = solicitacao.de;
          const horaFim = solicitacao.ate;
          if (horaInicio && horaFim) {
            const calculated = await calcularCustoHoraExtra(
              solicitacao.colaborador_id,
              horaInicio,
              horaFim
            );
            if (calculated) {
              custos = calculated;
            }
          }
        }

        const responseData: Record<string, unknown> = {
          solicitacao: {
            id: solicitacao.id,
            solicitante: solicitacao.solicitante,
            gestor: solicitacao.gestor,
            data: solicitacao.data,
            de: solicitacao.de,
            ate: solicitacao.ate,
            status: solicitacao.status,
            cargo: solicitacao.cargo,
            filial: solicitacao.filial,
            criado_em: solicitacao.criado_em,
          },
        };

        if (custos) {
          responseData.custos = {
            horas_extras: parseFloat(custos.horas_extras),
            valor_he_base: parseFloat(custos.valor_he_base),
            valor_dsr: parseFloat(custos.valor_dsr),
            valor_13: parseFloat(custos.valor_13),
            valor_ferias: parseFloat(custos.valor_ferias),
            um_terco_ferias: parseFloat(custos.um_terco_ferias),
            valor_fgts: parseFloat(custos.valor_fgts),
            valor_inss: parseFloat(custos.valor_inss),
            custo_dia: parseFloat(custos.custo_dia),
            custo_mes: parseFloat(custos.custo_mes),
            custo_ano: parseFloat(custos.custo_ano),
          };
        } else {
          responseData.custos = null;
        }

        return NextResponse.json(
          { success: true, data: responseData },
          { headers: CORS_HEADERS }
        );
      } catch (error) {
        console.error('Erro ao buscar custos HE (externo):', error);
        return serverErrorResponse('Erro ao buscar custos da solicitação');
      }
    },
    { modulo: 'horas_extras', permissaoMinima: 'read' }
  );
}
