import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { isSuperAdmin } from '@/lib/auth';

// GET /api/v1/jornadas/equipe?data=YYYY-MM-DD&departamentoId=N
//
// Lista todos os colaboradores do mesmo departamento do gestor logado,
// junto com as marcações de ponto do dia informado (default: hoje).
//
// Comportamento:
//  - Gestor padrão (Nível 2): equipe = colaboradores do próprio departamento.
//  - Admin / god mode (userId === 1) ou Nível 3: pode escolher
//    qualquer departamento via query param `departamentoId`. Sem o param,
//    cai no comportamento padrão (próprio departamento).
//
// Resposta: { departamento: {id, nome}, data: 'YYYY-MM-DD',
//            colaboradores: [{id, nome, foto, cargo, marcacoes: [...]}] }

export async function GET(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const data = searchParams.get('data') ?? new Date().toISOString().slice(0, 10);
      const departamentoIdParam = searchParams.get('departamentoId');

      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        return errorResponse('Parâmetro `data` deve estar no formato YYYY-MM-DD', 400);
      }

      // Resolve departamento alvo:
      //   1. Super admin/Nível 3 podem escolher qualquer dept via query param
      //   2. Caso contrário, usa o departamento do próprio gestor logado
      let departamentoId: number | null = null;
      if (departamentoIdParam && isSuperAdmin(user)) {
        const n = parseInt(departamentoIdParam, 10);
        if (!Number.isNaN(n)) departamentoId = n;
      }
      if (departamentoId === null) {
        // Pega departamento do colaborador autenticado.
        const meResult = await query<{ departamento_id: number | null }>(
          `SELECT departamento_id FROM people.colaboradores WHERE id = $1 LIMIT 1`,
          [user.userId],
        );
        departamentoId = meResult.rows[0]?.departamento_id ?? null;
      }

      if (departamentoId === null) {
        return errorResponse(
          'Você não está vinculado a nenhum departamento. Peça ao admin para associar o seu cadastro a um departamento.',
          400,
        );
      }

      // Carrega o nome do departamento (também valida existência).
      const deptResult = await query<{ id: number; nome: string }>(
        `SELECT id, nome FROM people.departamentos WHERE id = $1 LIMIT 1`,
        [departamentoId],
      );
      const departamento = deptResult.rows[0];
      if (!departamento) {
        return errorResponse('Departamento não encontrado', 404);
      }

      // Lista colaboradores ATIVOS do departamento.
      const colabResult = await query<{
        id: number;
        nome: string;
        foto_url: string | null;
        cargo_id: number | null;
        cargo_nome: string | null;
      }>(
        `SELECT c.id, c.nome, c.foto_url, c.cargo_id, cg.nome AS cargo_nome
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
          WHERE c.departamento_id = $1 AND c.status = 'ativo'
          ORDER BY c.nome ASC`,
        [departamentoId],
      );

      // Carrega marcações do dia para todos os colaboradores em uma única query.
      const colaboradorIds = colabResult.rows.map((r) => r.id);
      const marcacoesPorColab = new Map<
        number,
        Array<{
          id: number;
          dataHora: Date;
          tipo: string;
          metodo: string | null;
          fotoUrl: string | null;
          latitude: number | null;
          longitude: number | null;
        }>
      >();

      if (colaboradorIds.length > 0) {
        const margResult = await query<{
          id: number;
          colaborador_id: number;
          data_hora: Date;
          tipo: string;
          metodo: string | null;
          foto_url: string | null;
          latitude: string | null;
          longitude: string | null;
        }>(
          `SELECT id, colaborador_id, data_hora, tipo, metodo, foto_url,
                  latitude::text AS latitude, longitude::text AS longitude
             FROM people.marcacoes
            WHERE colaborador_id = ANY($1::int[])
              AND data_hora >= $2::date
              AND data_hora < ($2::date + interval '1 day')
            ORDER BY data_hora ASC`,
          [colaboradorIds, data],
        );

        for (const m of margResult.rows) {
          const lista = marcacoesPorColab.get(m.colaborador_id) ?? [];
          lista.push({
            id: m.id,
            dataHora: m.data_hora,
            tipo: m.tipo,
            metodo: m.metodo,
            fotoUrl: m.foto_url,
            latitude: m.latitude !== null ? parseFloat(m.latitude) : null,
            longitude: m.longitude !== null ? parseFloat(m.longitude) : null,
          });
          marcacoesPorColab.set(m.colaborador_id, lista);
        }
      }

      const colaboradores = colabResult.rows.map((c) => {
        const marcacoes = marcacoesPorColab.get(c.id) ?? [];
        // Status visual da jornada do dia, derivado das marcações:
        //  - sem_marcacao: ainda não bateu nada
        //  - em_andamento: bateu entrada mas não bateu saída
        //  - finalizado: já bateu saída
        let statusJornada: 'sem_marcacao' | 'em_andamento' | 'finalizado';
        if (marcacoes.length === 0) {
          statusJornada = 'sem_marcacao';
        } else if (marcacoes.some((m) => m.tipo === 'saida')) {
          statusJornada = 'finalizado';
        } else {
          statusJornada = 'em_andamento';
        }

        return {
          id: c.id,
          nome: c.nome,
          foto: c.foto_url,
          cargo: c.cargo_id ? { id: c.cargo_id, nome: c.cargo_nome ?? '' } : null,
          statusJornada,
          totalMarcacoes: marcacoes.length,
          marcacoes,
        };
      });

      return successResponse({
        departamento: { id: departamento.id, nome: departamento.nome },
        data,
        totalColaboradores: colaboradores.length,
        colaboradores,
      });
    } catch (error) {
      console.error('[jornadas/equipe] erro:', error);
      return serverErrorResponse('Erro ao listar jornadas da equipe');
    }
  });
}
