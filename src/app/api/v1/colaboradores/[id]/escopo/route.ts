import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import {
  obterEscopoGestor,
  definirEscopoGestor,
} from '@/lib/escopo-gestor';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/colaboradores/:id/escopo
// Retorna o escopo de gestão de um colaborador (departamentos + empresas).
// Inclui o "departamento próprio" do colaborador na lista, com flag
// `proprio: true`, pra UI deixar claro o que é gestão herdada vs. atribuída.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(_request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id, 10);
      if (Number.isNaN(colaboradorId)) {
        return errorResponse('ID inválido', 400);
      }

      const colabResult = await query<{
        id: number;
        nome: string;
        departamento_id: number | null;
      }>(
        `SELECT id, nome, departamento_id
           FROM people.colaboradores
          WHERE id = $1 LIMIT 1`,
        [colaboradorId],
      );
      if (colabResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }
      const colab = colabResult.rows[0];

      // Carrega vínculos diretos (sem o "próprio" implícito) pra exibir
      // separadamente no UI.
      const [deptDireto, empresas] = await Promise.all([
        query<{ departamento_id: number; nome: string }>(
          `SELECT gd.departamento_id, d.nome
             FROM people.gestor_departamentos gd
             JOIN people.departamentos d ON d.id = gd.departamento_id
            WHERE gd.colaborador_id = $1
            ORDER BY d.nome ASC`,
          [colaboradorId],
        ),
        query<{ empresa_id: number; nome_fantasia: string | null; razao_social: string | null }>(
          `SELECT ge.empresa_id, e.nome_fantasia, e.razao_social
             FROM people.gestor_empresas ge
             JOIN people.empresas e ON e.id = ge.empresa_id
            WHERE ge.colaborador_id = $1
            ORDER BY COALESCE(e.nome_fantasia, e.razao_social) ASC`,
          [colaboradorId],
        ),
      ]);

      // Departamento próprio (caso exista) vai marcado pra UI
      let departamentoProprio: { id: number; nome: string } | null = null;
      if (colab.departamento_id != null) {
        const r = await query<{ nome: string }>(
          `SELECT nome FROM people.departamentos WHERE id = $1 LIMIT 1`,
          [colab.departamento_id],
        );
        if (r.rows[0]) {
          departamentoProprio = { id: colab.departamento_id, nome: r.rows[0].nome };
        }
      }

      return successResponse({
        colaborador: { id: colab.id, nome: colab.nome },
        departamentoProprio,
        departamentos: deptDireto.rows.map((r) => ({
          id: r.departamento_id,
          nome: r.nome,
        })),
        empresas: empresas.rows.map((r) => ({
          id: r.empresa_id,
          nome: r.nome_fantasia || r.razao_social || `Empresa ${r.empresa_id}`,
        })),
      });
    } catch (error) {
      console.error('[colaboradores/:id/escopo] erro GET:', error);
      return serverErrorResponse('Erro ao obter escopo do colaborador');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/colaboradores/:id/escopo
// Substitui o escopo de gestão (idempotente: apaga e insere).
// Body: { departamentoIds: number[], empresaIds: number[] }
// ─────────────────────────────────────────────────────────────────────────────

const putSchema = z.object({
  departamentoIds: z.array(z.number().int().positive()).max(500).optional(),
  empresaIds: z.array(z.number().int().positive()).max(500).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id, 10);
      if (Number.isNaN(colaboradorId)) {
        return errorResponse('ID inválido', 400);
      }

      const body = await req.json().catch(() => ({}));
      const parsed = putSchema.safeParse(body);
      if (!parsed.success) {
        return validationErrorResponse({
          body: parsed.error.issues.map((i) => i.message),
        });
      }

      const colabResult = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 LIMIT 1`,
        [colaboradorId],
      );
      if (colabResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }
      const colab = colabResult.rows[0];

      const departamentoIds = parsed.data.departamentoIds ?? [];
      const empresaIds = parsed.data.empresaIds ?? [];

      // Valida que IDs informados existem (evita gravar lixo)
      if (departamentoIds.length > 0) {
        const r = await query<{ id: number }>(
          `SELECT id FROM people.departamentos WHERE id = ANY($1::int[])`,
          [departamentoIds],
        );
        if (r.rows.length !== departamentoIds.length) {
          return errorResponse(
            'Algum departamento informado não existe',
            400,
          );
        }
      }
      if (empresaIds.length > 0) {
        const r = await query<{ id: number }>(
          `SELECT id FROM people.empresas WHERE id = ANY($1::int[])`,
          [empresaIds],
        );
        if (r.rows.length !== empresaIds.length) {
          return errorResponse('Alguma empresa informada não existe', 400);
        }
      }

      const escopoAntigo = await obterEscopoGestor(colaboradorId);

      await definirEscopoGestor(
        colaboradorId,
        { departamentoIds, empresaIds },
        { atualizadoPor: user.userId > 0 ? user.userId : null },
      );

      // Mudança de escopo afeta filtros de listagem (colaboradores,
      // marcacoes, solicitacoes, pendencias, ferias, horas extras).
      // Invalida caches dependentes para evitar stale data.
      try {
        await Promise.all([
          cacheDelPattern(`${CACHE_KEYS.COLABORADORES}*`),
          cacheDelPattern(`${CACHE_KEYS.MARCACOES}*`),
          cacheDelPattern(`${CACHE_KEYS.SOLICITACOES}*`),
          cacheDelPattern(`${CACHE_KEYS.PENDENCIAS}*`),
          cacheDelPattern(`${CACHE_KEYS.HORAS_EXTRAS}*`),
        ]);
      } catch (e) {
        // best-effort — não falha o request por cache miss
        console.warn('[escopo] falha ao invalidar cache:', e);
      }

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'colaboradores',
          descricao: `Escopo de gestão atualizado para "${colab.nome}" (#${colab.id})`,
          dadosAnteriores: { ...escopoAntigo },
          dadosNovos: { departamentoIds, empresaIds },
        }),
      );

      return successResponse({
        colaborador: { id: colab.id, nome: colab.nome },
        departamentoIds,
        empresaIds,
        mensagem: 'Escopo atualizado com sucesso',
      });
    } catch (error) {
      console.error('[colaboradores/:id/escopo] erro PUT:', error);
      return serverErrorResponse('Erro ao atualizar escopo do colaborador');
    }
  });
}
