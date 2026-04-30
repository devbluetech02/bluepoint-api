import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { obterPermissoesEfetivasComColaborador } from '@/lib/permissoes-efetivas';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/colaboradores/:id/permissoes
// Retorna o conjunto efetivo de permissões do colaborador, com a origem
// de cada uma (nivel | cargo | pessoa) e a lista bruta de overrides
// individuais ativos. Usado pela aba "Permissões" no modal do cargo.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id, 10);
      if (Number.isNaN(colaboradorId) || colaboradorId <= 0) {
        return errorResponse('ID inválido', 400);
      }

      const colabResult = await query<{
        id: number;
        nome: string;
        tipo: string;
        cargo_id: number | null;
        cargo_nome: string | null;
        nivel_acesso_id: number | null;
      }>(
        `SELECT c.id, c.nome, c.tipo::text AS tipo,
                c.cargo_id,
                cg.nome AS cargo_nome,
                cg.nivel_acesso_id
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
          WHERE c.id = $1 LIMIT 1`,
        [colaboradorId],
      );
      if (colabResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }
      const colab = colabResult.rows[0];

      const efetivas = await obterPermissoesEfetivasComColaborador({
        colaboradorId,
        cargoId: colab.cargo_id,
        nivelId: colab.nivel_acesso_id,
        tipoLegado: colab.tipo,
      });

      // Mapeia codigo → id pra que o cliente possa criar overrides direto
      // a partir da lista de efetivas, sem precisar de outra chamada.
      const idsPorCodigo = efetivas.codigos.length === 0
        ? new Map<string, number>()
        : await query<{ id: number; codigo: string }>(
            `SELECT id, codigo FROM people.permissoes WHERE codigo = ANY($1::text[])`,
            [efetivas.codigos],
          ).then((r) => new Map(r.rows.map((row) => [row.codigo, row.id])));

      // Lista bruta dos overrides individuais (concedidos e removidos).
      const overrides = await query<{
        permissao_id: number;
        codigo: string;
        nome: string;
        modulo: string;
        concedido: boolean;
        motivo: string | null;
        atualizado_em: Date;
      }>(
        `SELECT cpo.permissao_id,
                p.codigo, p.nome, p.modulo,
                cpo.concedido, cpo.motivo, cpo.atualizado_em
           FROM people.colaborador_permissoes_override cpo
           JOIN people.permissoes p ON p.id = cpo.permissao_id
          WHERE cpo.colaborador_id = $1
          ORDER BY p.codigo`,
        [colaboradorId],
      );

      return successResponse({
        colaborador: {
          id: colab.id,
          nome: colab.nome,
          cargo: colab.cargo_id
            ? { id: colab.cargo_id, nome: colab.cargo_nome }
            : null,
          nivelId: colab.nivel_acesso_id,
        },
        efetivas: efetivas.codigos.map((codigo) => ({
          permissaoId: idsPorCodigo.get(codigo) ?? null,
          codigo,
          origem: efetivas.origem[codigo],
        })),
        overrides: overrides.rows.map((r) => ({
          permissaoId: r.permissao_id,
          codigo: r.codigo,
          nome: r.nome,
          modulo: r.modulo,
          concedido: r.concedido,
          motivo: r.motivo,
          atualizadoEm: r.atualizado_em,
        })),
      });
    } catch (error) {
      console.error('[colaboradores/:id/permissoes] erro GET:', error);
      return serverErrorResponse('Erro ao obter permissões do colaborador');
    }
  });
}
