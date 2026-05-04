import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { isSuperAdmin } from '@/lib/auth';
import {
  obterEscopoGestor,
  listarColaboradoresNoEscopo,
} from '@/lib/escopo-gestor';

// GET /api/v1/jornadas/equipe?data=YYYY-MM-DD
//
// Lista colaboradores no escopo de gestão do líder logado, junto com
// as marcações de ponto do dia informado (default: hoje).
//
// Escopo (expandido pelas tabelas gestor_departamentos / gestor_empresas):
//  - Departamento próprio do gestor (regra implícita).
//  - Todos os departamentos onde ele está em `gestor_departamentos`.
//  - Todos os colaboradores das empresas em `gestor_empresas`.
//  - Super admin (userId === 1): vê tudo (sem filtro).
//
// Resposta: { escopo: {...}, data, totalColaboradores, colaboradores: [...] }

export async function GET(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const data = searchParams.get('data') ?? new Date().toISOString().slice(0, 10);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        return errorResponse('Parâmetro `data` deve estar no formato YYYY-MM-DD', 400);
      }

      // Resolve escopo do gestor
      const escopo = await obterEscopoGestor(user.userId);
      const ehSuperAdmin = isSuperAdmin(user);

      // Lista colaboradores no escopo. Super admin = todos os ativos.
      let colaboradorIds: number[];
      if (ehSuperAdmin) {
        const r = await query<{ id: number }>(
          `SELECT id FROM people.colaboradores
            WHERE status = 'ativo'
            ORDER BY nome ASC`,
        );
        colaboradorIds = r.rows.map((row) => row.id);
      } else {
        colaboradorIds = await listarColaboradoresNoEscopo(escopo);
      }

      if (colaboradorIds.length === 0) {
        return successResponse({
          escopo: {
            departamentoIds: escopo.departamentoIds,
            empresaIds: escopo.empresaIds,
            ehSuperAdmin,
          },
          data,
          totalColaboradores: 0,
          colaboradores: [],
        });
      }

      // Carrega dados dos colaboradores em uma query
      const colabResult = await query<{
        id: number;
        nome: string;
        foto_url: string | null;
        cargo_id: number | null;
        cargo_nome: string | null;
        departamento_id: number | null;
        departamento_nome: string | null;
        empresa_id: number | null;
      }>(
        `SELECT c.id, c.nome, c.foto_url,
                c.cargo_id, cg.nome AS cargo_nome,
                c.departamento_id, d.nome AS departamento_nome,
                c.empresa_id
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
           LEFT JOIN people.departamentos d ON d.id = c.departamento_id
          WHERE c.id = ANY($1::int[]) AND c.status = 'ativo'
          ORDER BY c.nome ASC`,
        [colaboradorIds],
      );

      // Marcações do dia em uma única query
      const marcacoesPorColab = new Map<
        number,
        Array<{
          id: number;
          dataHora: Date;
          tipo: string;
          metodo: string | null;
        }>
      >();

      // `data_hora` é TIMESTAMP sem TZ → node-postgres devolve string;
      // normaliza pra Date pra serializar como ISO com TZ no JSON
      // (front em Dart usa DateTime.parse + .toLocal()).
      const margResult = await query<{
        id: number;
        colaborador_id: number;
        data_hora: Date | string;
        tipo: string;
        metodo: string | null;
      }>(
        `SELECT id, colaborador_id, data_hora, tipo, metodo
           FROM people.marcacoes
          WHERE colaborador_id = ANY($1::int[])
            AND data_hora >= $2::date
            AND data_hora < ($2::date + interval '1 day')
          ORDER BY data_hora ASC`,
        [colaboradorIds, data],
      );

      for (const m of margResult.rows) {
        const lista = marcacoesPorColab.get(m.colaborador_id) ?? [];
        const dh = m.data_hora instanceof Date
          ? m.data_hora
          : new Date(String(m.data_hora).replace(' ', 'T') + 'Z');
        lista.push({
          id: m.id,
          dataHora: dh,
          tipo: m.tipo,
          metodo: m.metodo,
        });
        marcacoesPorColab.set(m.colaborador_id, lista);
      }

      const colaboradores = colabResult.rows.map((c) => {
        const marcacoes = marcacoesPorColab.get(c.id) ?? [];
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
          departamento: c.departamento_id
            ? { id: c.departamento_id, nome: c.departamento_nome ?? '' }
            : null,
          statusJornada,
          totalMarcacoes: marcacoes.length,
          marcacoes,
        };
      });

      return successResponse({
        escopo: {
          departamentoIds: escopo.departamentoIds,
          empresaIds: escopo.empresaIds,
          ehSuperAdmin,
        },
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
