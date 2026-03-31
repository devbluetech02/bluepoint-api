import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { liderancasDepartamentoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLiderancasDepartamentoCache, cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

async function buscarColaboradoresPorIds(ids: number[]): Promise<{ id: number; nome: string }[]> {
  if (!ids || ids.length === 0) return [];
  const result = await query(
    `SELECT id, nome FROM people.colaboradores WHERE id = ANY($1) ORDER BY nome ASC`,
    [ids]
  );
  return result.rows.map((r) => ({ id: r.id, nome: r.nome }));
}

// =====================================================
// GET - Listar lideranças de departamentos de uma empresa
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

      const cacheKey = `${CACHE_KEYS.LIDERANCAS_DEPARTAMENTO}list:${empresaId}`;

      const dados = await cacheAside(
        cacheKey,
        async () => {
          const result = await query(
            `SELECT ld.id, ld.empresa_id, ld.departamento_id,
                    d.nome AS departamento_nome,
                    ld.supervisor_ids, ld.coordenador_ids, ld.gerente_ids,
                    ld.created_at, ld.updated_at
             FROM people.liderancas_departamento ld
             JOIN people.departamentos d ON ld.departamento_id = d.id
             WHERE ld.empresa_id = $1
             ORDER BY d.nome ASC`,
            [empresaId]
          );

          return Promise.all(result.rows.map(async (row) => {
            const [supervisores, coordenadores, gerentes] = await Promise.all([
              buscarColaboradoresPorIds(row.supervisor_ids || []),
              buscarColaboradoresPorIds(row.coordenador_ids || []),
              buscarColaboradoresPorIds(row.gerente_ids || []),
            ]);

            return {
              id: row.id,
              empresa_id: row.empresa_id,
              departamento_id: row.departamento_id,
              departamento_nome: row.departamento_nome,
              supervisores,
              coordenadores,
              gerentes,
              created_at: row.created_at,
              updated_at: row.updated_at,
            };
          }));
        },
        CACHE_TTL.MEDIUM
      );

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar lideranças de departamento:', error);
      return serverErrorResponse('Erro ao listar lideranças de departamento');
    }
  });
}

// =====================================================
// POST - Criar ou atualizar lideranças de um departamento (UPSERT)
// =====================================================
export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(liderancasDepartamentoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { empresa_id, departamento_id, supervisor_ids, coordenador_ids, gerente_ids } = validation.data;

      const empresaResult = await query(
        `SELECT id FROM people.empresas WHERE id = $1`,
        [empresa_id]
      );
      if (empresaResult.rows.length === 0) {
        return errorResponse('Empresa não encontrada', 404);
      }

      const deptResult = await query(
        `SELECT id, nome FROM people.departamentos WHERE id = $1`,
        [departamento_id]
      );
      if (deptResult.rows.length === 0) {
        return errorResponse('Departamento não encontrado', 404);
      }

      const departamentoNome = deptResult.rows[0].nome;

      const result = await query(
        `INSERT INTO people.liderancas_departamento
           (empresa_id, departamento_id, supervisor_ids, coordenador_ids, gerente_ids)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (empresa_id, departamento_id) DO UPDATE SET
           supervisor_ids = $3,
           coordenador_ids = $4,
           gerente_ids = $5,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [empresa_id, departamento_id, supervisor_ids, coordenador_ids, gerente_ids]
      );

      const row = result.rows[0];

      const [supervisores, coordenadores, gerentes] = await Promise.all([
        buscarColaboradoresPorIds(row.supervisor_ids || []),
        buscarColaboradoresPorIds(row.coordenador_ids || []),
        buscarColaboradoresPorIds(row.gerente_ids || []),
      ]);

      await invalidateLiderancasDepartamentoCache();

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'liderancas_departamento',
        descricao: `Lideranças do departamento "${departamentoNome}" atualizadas`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { empresa_id, departamento_id, supervisor_ids, coordenador_ids, gerente_ids },
      });

      return successResponse({
        id: row.id,
        empresa_id: row.empresa_id,
        departamento_id: row.departamento_id,
        departamento_nome: departamentoNome,
        supervisores,
        coordenadores,
        gerentes,
        message: 'Lideranças atualizadas com sucesso',
      });
    } catch (error) {
      console.error('Erro ao salvar lideranças de departamento:', error);
      return serverErrorResponse('Erro ao salvar lideranças de departamento');
    }
  });
}
