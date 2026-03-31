import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { limitesHeGestoresSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import {
  CACHE_KEYS,
  invalidateLimitesHeGestoresCache,
} from '@/lib/cache';
import { calcularAcumuladoMesGestor } from '@/lib/custoHorasExtrasService';

// =====================================================
// @deprecated — Substituído por /api/v1/limites-he-empresas e /api/v1/limites-he-departamentos
// Mantido para compatibilidade; o frontend já não utiliza estes endpoints.
// =====================================================

// =====================================================
// GET - Listar todos os gestores com seus limites e saldo
// =====================================================
export async function GET(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      const result = await query(
        `SELECT c.id as gestor_id, c.nome as gestor_nome, c.email,
                l.id as limite_id, l.limite_mensal, l.pode_extrapolar,
                l.created_at, l.updated_at
         FROM people.colaboradores c
         LEFT JOIN people.limites_he_gestores l ON c.id = l.gestor_id
         WHERE c.tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')
           AND c.status = 'ativo'
         ORDER BY c.nome ASC`
      );

      const dados = await Promise.all(result.rows.map(async (row) => {
        const limiteMensal = row.limite_mensal ? parseFloat(row.limite_mensal) : null;
        let acumuladoMes = 0;
        let saldoDisponivel: number | null = null;
        let totalAprovacoesMes = 0;

        if (limiteMensal !== null) {
          const acumulado = await calcularAcumuladoMesGestor(row.gestor_id);
          acumuladoMes = acumulado.total;
          totalAprovacoesMes = acumulado.qtd;
          saldoDisponivel = parseFloat(Math.max(0, limiteMensal - acumuladoMes).toFixed(2));
        }

        return {
          gestor_id: row.gestor_id,
          gestor_nome: row.gestor_nome,
          email: row.email,
          limite_id: row.limite_id || null,
          limite_mensal: limiteMensal,
          pode_extrapolar: row.limite_id ? row.pode_extrapolar : true,
          acumulado_mes: acumuladoMes,
          saldo_disponivel: saldoDisponivel,
          total_aprovacoes_mes: totalAprovacoesMes,
          created_at: row.created_at || null,
          updated_at: row.updated_at || null,
        };
      }));

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar limites de HE por gestor:', error);
      return serverErrorResponse('Erro ao listar limites de horas extras por gestor');
    }
  });
}

// =====================================================
// POST - Criar, atualizar ou remover limite de um gestor
// =====================================================
export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(limitesHeGestoresSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { gestor_id, limite_mensal, pode_extrapolar } = validation.data;

      const gestorResult = await query(
        `SELECT id, nome, tipo FROM people.colaboradores
         WHERE id = $1 AND status = 'ativo'
           AND tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')`,
        [gestor_id]
      );

      if (gestorResult.rows.length === 0) {
        return errorResponse('Gestor não encontrado, inativo ou sem perfil de gestor', 404);
      }

      const gestorNome = gestorResult.rows[0].nome;

      if (limite_mensal === null || limite_mensal === '' || limite_mensal === undefined) {
        await query(
          `DELETE FROM people.limites_he_gestores WHERE gestor_id = $1`,
          [gestor_id]
        );

        await invalidateLimitesHeGestoresCache();

        await registrarAuditoria({
          usuarioId: user.userId,
          acao: 'excluir',
          modulo: 'limites_he_gestores',
          descricao: `Limite de HE removido do gestor "${gestorNome}"`,
          ip: getClientIp(request),
          userAgent: getUserAgent(request),
          dadosAnteriores: { gestor_id },
        });

        return successResponse({
          gestor_id,
          gestor_nome: gestorNome,
          limite_mensal: null,
          pode_extrapolar: true,
          message: 'Limite removido com sucesso',
        });
      }

      const limiteNumerico = typeof limite_mensal === 'number' ? limite_mensal : parseFloat(String(limite_mensal));

      if (isNaN(limiteNumerico) || limiteNumerico < 0) {
        return errorResponse('Limite mensal deve ser um número não-negativo');
      }

      const podeExtrapolarValor = pode_extrapolar !== undefined ? pode_extrapolar : true;

      const result = await query(
        `INSERT INTO people.limites_he_gestores (gestor_id, limite_mensal, pode_extrapolar)
         VALUES ($1, $2, $3)
         ON CONFLICT (gestor_id) DO UPDATE SET
           limite_mensal = $2,
           pode_extrapolar = $3,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [gestor_id, limiteNumerico, podeExtrapolarValor]
      );

      await invalidateLimitesHeGestoresCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'limites_he_gestores',
        descricao: `Limite de HE atualizado para gestor "${gestorNome}": R$ ${limiteNumerico.toFixed(2)} (${podeExtrapolarValor ? 'pode extrapolar' : 'não pode extrapolar'})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { gestor_id, limite_mensal: limiteNumerico, pode_extrapolar: podeExtrapolarValor },
      });

      return successResponse({
        ...result.rows[0],
        gestor_nome: gestorNome,
        message: 'Limite atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao gerenciar limite de HE por gestor:', error);
      return serverErrorResponse('Erro ao gerenciar limite de horas extras por gestor');
    }
  });
}
