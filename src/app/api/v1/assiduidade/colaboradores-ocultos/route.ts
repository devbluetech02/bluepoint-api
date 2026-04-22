import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

/**
 * GET /api/v1/assiduidade/colaboradores-ocultos
 * Lista colaboradores marcados como ocultos na assiduidade.
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const result = await query<{ colaborador_id: number; colaborador_nome: string }>(
        `SELECT o.colaborador_id, c.nome AS colaborador_nome
         FROM people.assiduidade_colaboradores_ocultos o
         JOIN people.colaboradores c ON c.id = o.colaborador_id
         ORDER BY c.nome`
      );
      return successResponse({
        colaboradores: result.rows.map((r) => ({
          colaborador_id: r.colaborador_id,
          colaborador_nome: r.colaborador_nome,
        })),
      });
    } catch (e) {
      console.error('Erro ao listar colaboradores ocultos (assiduidade):', e);
      return serverErrorResponse('Erro ao listar colaboradores ocultos');
    }
  });
}

/**
 * POST /api/v1/assiduidade/colaboradores-ocultos
 * Body: { colaborador_id: number }
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json().catch(() => ({}));
      const colaboradorId = parseInt(body.colaborador_id ?? '', 10);

      if (!colaboradorId || isNaN(colaboradorId)) {
        return errorResponse('colaborador_id obrigatório e numérico', 400);
      }

      const exist = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );
      if (exist.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      await query(
        `INSERT INTO people.assiduidade_colaboradores_ocultos (colaborador_id)
         VALUES ($1)
         ON CONFLICT (colaborador_id) DO NOTHING`,
        [colaboradorId]
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'assiduidade',
          descricao: `Colaborador ocultado na visão de assiduidade: ${exist.rows[0].nome}`,
          colaboradorId,
          colaboradorNome: exist.rows[0].nome,
          entidadeId: colaboradorId,
          entidadeTipo: 'colaborador',
        })
      );

      return successResponse({
        colaborador_id: colaboradorId,
        mensagem: 'Colaborador ocultado',
      });
    } catch (e) {
      console.error('Erro ao ocultar colaborador (assiduidade):', e);
      return serverErrorResponse('Erro ao ocultar colaborador');
    }
  });
}
