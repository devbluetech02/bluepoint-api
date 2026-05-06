import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

// Cargos cujo nome (normalizado, accent-insensitive, UPPER) faz match
// contra qualquer um destes substrings sao filtrados — nivel 2/3 mas
// nao aprovam solicitacoes rotineiras de ponto/hora extra.
const CARGOS_EXCLUIDOS_SUBSTRINGS = ['RECRUTADOR', 'RECRUTAMENTO', 'OWNER'];

// GET /api/v1/colaboradores/gestores-disponiveis
//
// Lista enxuta de gestores ativos pra dropdown de "Selecione o gestor"
// em telas de solicitação (hora extra, ajuste de ponto, etc.).
//
// Difere de /listar-colaboradores em dois pontos:
//   1. Não aplica filtro de escopo — colaborador comum precisa enxergar
//      gestores fora do próprio cadastro pra escolher quem aprova.
//   2. Filtra por nível_id >= 2 (gestor/admin) via cargos.nivel_acesso_id,
//      em vez de inferir por substring de cargo (heurística antiga).
//
// Payload mínimo (id, nome, cargo, departamento, foto) — sem expor
// e-mail, CPF, telefone ou dados internos.

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      // Monta clausulas dinamicas pra filtrar cargos excluidos.
      // translate cobre acentuacao PT-BR sem exigir extensao unaccent
      // (mesmo padrao do helper normalizar-nome).
      const cargoNomeNormalizado = `UPPER(translate(COALESCE(cg.nome, ''),
        'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
        'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))`;
      const cargoFilters = CARGOS_EXCLUIDOS_SUBSTRINGS.map(
        (sub, i) => `${cargoNomeNormalizado} NOT LIKE $${i + 2}`,
      ).join(' AND ');
      const cargoFilterParams = CARGOS_EXCLUIDOS_SUBSTRINGS.map((s) => `%${s}%`);

      const result = await query<{
        id: number;
        nome: string;
        foto_url: string | null;
        cargo_id: number | null;
        cargo_nome: string | null;
        departamento_id: number | null;
        departamento_nome: string | null;
        empresa_id: number | null;
        empresa_nome: string | null;
      }>(
        `SELECT c.id, c.nome, c.foto_url,
                c.cargo_id, cg.nome AS cargo_nome,
                c.departamento_id, d.nome AS departamento_nome,
                c.empresa_id, e.nome_fantasia AS empresa_nome
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg        ON cg.id = c.cargo_id
           LEFT JOIN people.departamentos d  ON d.id = c.departamento_id
           LEFT JOIN people.empresas e       ON e.id = c.empresa_id
          WHERE c.status = 'ativo'
            AND c.id <> $1
            AND cg.nivel_acesso_id IS NOT NULL
            AND cg.nivel_acesso_id >= 2
            AND ${cargoFilters}
          ORDER BY c.nome ASC`,
        [user.userId, ...cargoFilterParams],
      );

      const dados = result.rows.map((r) => ({
        id: r.id,
        nome: r.nome,
        foto: r.foto_url,
        cargo: r.cargo_id ? { id: r.cargo_id, nome: r.cargo_nome ?? '' } : null,
        departamento: r.departamento_id
          ? { id: r.departamento_id, nome: r.departamento_nome ?? '' }
          : null,
        empresa: r.empresa_id
          ? { id: r.empresa_id, nome: r.empresa_nome ?? '' }
          : null,
      }));

      return successResponse(dados);
    } catch (error) {
      console.error('[colaboradores/gestores-disponiveis] erro:', error);
      return serverErrorResponse('Erro ao listar gestores disponíveis');
    }
  });
}
