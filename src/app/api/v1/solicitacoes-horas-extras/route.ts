import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { criarSolicitacaoHorasExtrasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import {
  cacheAside,
  buildListCacheKey,
  CACHE_KEYS,
  CACHE_TTL,
  invalidateSolicitacoesHorasExtrasCache,
} from '@/lib/cache';
import {
  calcularCustoHoraExtra,
  salvarCustoHoraExtra,
  calcularHorasDecimais,
} from '@/lib/custoHorasExtrasService';

function extrairHorario(valor: string): string {
  if (valor.includes('T')) {
    const parts = valor.split('T');
    return parts[1].substring(0, 5);
  }
  return valor.substring(0, 5);
}

// =====================================================
// POST - Criar nova solicitação de hora extra
// =====================================================
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(criarSolicitacaoHorasExtrasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const de = extrairHorario(data.de);
      const ate = extrairHorario(data.ate);

      if (!data.solicitante || !data.data || !de || !ate) {
        return errorResponse('Campos obrigatórios: solicitante, data, de, ate');
      }

      const colaboradorId = data.colaborador_id ?? null;

      // Inserir solicitação
      const insertResult = await query(
        `INSERT INTO people.solicitacoes_horas_extras
           (solicitante, gestor, data, de, ate, colaborador_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pendente')
         RETURNING *`,
        [data.solicitante, data.gestor, data.data, de, ate, colaboradorId]
      );

      const solicitacao = insertResult.rows[0];

      let custoData = null;

      // Calcular e salvar custos se colaborador_id presente
      if (colaboradorId) {
        const custos = await calcularCustoHoraExtra(colaboradorId, de, ate);
        if (custos) {
          await salvarCustoHoraExtra(
            solicitacao.id,
            colaboradorId,
            custos.cargo_id,
            custos.empresa_id,
            custos
          );
          custoData = custos;
        }
      }

      await invalidateSolicitacoesHorasExtrasCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'custos_horas_extras',
        descricao: `Solicitação de hora extra criada: ${data.solicitante} em ${data.data} (${de}-${ate})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { solicitacaoId: solicitacao.id, ...data },
      });

      const horasExtras = calcularHorasDecimais(de, ate);

      return successResponse({
        ...solicitacao,
        cargo: custoData?.cargo || null,
        filial: custoData?.empresa || null,
        horas_extras: horasExtras,
        custo_dia: custoData?.custo_dia || null,
        custo_mes: custoData?.custo_mes || null,
        custo_ano: custoData?.custo_ano || null,
        message: 'Solicitação de horas extras criada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar solicitação de horas extras:', error);
      return serverErrorResponse('Erro ao criar solicitação de horas extras');
    }
  });
}

// =====================================================
// GET - Listar solicitações de horas extras
// =====================================================
export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);

      const search = searchParams.get('search');
      const gestor = searchParams.get('gestor');
      const dataInicio = searchParams.get('data_inicio');
      const dataFim = searchParams.get('data_fim');
      const colaboradorId = searchParams.get('colaborador_id');
      const equipeId = searchParams.get('equipe_id');
      const departamentoId = searchParams.get('departamento_id');
      const departamento = searchParams.get('departamento');
      const solicitanteNome = searchParams.get('solicitante_nome');

      const cacheKey = buildListCacheKey(CACHE_KEYS.SOLICITACOES_HORAS_EXTRAS, {
        search, gestor, dataInicio, dataFim, colaboradorId, equipeId,
        departamentoId, departamento, solicitanteNome,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (search) {
          conditions.push(
            `(s.id::text ILIKE $${paramIndex} OR s.solicitante ILIKE $${paramIndex} OR s.gestor ILIKE $${paramIndex})`
          );
          params.push(`%${search}%`);
          paramIndex++;
        }

        if (gestor) {
          conditions.push(`LOWER(s.gestor) = LOWER($${paramIndex})`);
          params.push(gestor);
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

        if (colaboradorId) {
          conditions.push(`s.colaborador_id = $${paramIndex}`);
          params.push(parseInt(colaboradorId));
          paramIndex++;
        }

        if (equipeId) {
          conditions.push(`c.departamento_id = $${paramIndex}`);
          params.push(parseInt(equipeId));
          paramIndex++;
        }

        if (departamentoId) {
          conditions.push(`c.departamento_id = $${paramIndex}`);
          params.push(parseInt(departamentoId));
          paramIndex++;
        }

        if (departamento) {
          conditions.push(`d.nome ILIKE $${paramIndex}`);
          params.push(`%${departamento}%`);
          paramIndex++;
        }

        if (solicitanteNome) {
          conditions.push(`s.solicitante ILIKE $${paramIndex}`);
          params.push(`%${solicitanteNome}%`);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await query(
          `SELECT s.*, cg.nome AS cargo, e.nome_fantasia AS filial
           FROM people.solicitacoes_horas_extras s
           LEFT JOIN people.colaboradores c ON s.colaborador_id = c.id
           LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
           LEFT JOIN people.empresas e ON c.empresa_id = e.id
           LEFT JOIN people.departamentos d ON c.departamento_id = d.id
           ${whereClause}
           ORDER BY s.criado_em DESC`,
          params
        );

        if (result.rows.length === 0) return result.rows;

        const ids = result.rows.map((r) => r.id);
        const custosResult = await query(
          `SELECT solicitacao_id, horas_extras, custo_dia, custo_mes, custo_ano
           FROM people.custo_horas_extras
           WHERE solicitacao_id = ANY($1)`,
          [ids]
        );

        const custosMap = new Map(
          custosResult.rows.map((c) => [c.solicitacao_id, c])
        );

        return result.rows.map((row) => {
          const custo = custosMap.get(row.id);
          return {
            ...row,
            horas_extras: custo ? parseFloat(custo.horas_extras) : null,
            custo_dia: custo ? parseFloat(custo.custo_dia) : null,
            custo_mes: custo ? parseFloat(custo.custo_mes) : null,
            custo_ano: custo ? parseFloat(custo.custo_ano) : null,
          };
        });
      }, CACHE_TTL.SHORT);

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao listar solicitações de horas extras:', error);
      return serverErrorResponse('Erro ao listar solicitações de horas extras');
    }
  });
}
