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

// GET /api/v1/jornadas/equipe-resumo-mensal?mes=N&ano=Y
//
// Resumo mensal agregado por colaborador para o gestor logado, dentro do
// escopo (departamentos + empresas via gestor_departamentos/gestor_empresas).
//
// Lê da tabela `people.relatorios_mensais` (populada sob demanda pelo
// /relatorio-mensal/[id]). Quando ainda não há registro pra um colaborador
// no mês, devolve zeros — caller decide se chama o endpoint individual
// pra calcular ou apenas exibe "—".
//
// Resposta:
//   { mes, ano, escopo, totalColaboradores, colaboradores: [{...}] }

interface ColabRow {
  id: number;
  nome: string;
  foto_url: string | null;
  cargo_id: number | null;
  cargo_nome: string | null;
  departamento_id: number | null;
  departamento_nome: string | null;
}

interface RelatorioRow {
  colaborador_id: number;
  dias_trabalhados: number | null;
  horas_trabalhadas: string | null;
  horas_extras: string | null;
  banco_horas: string | null;
  faltas: number | null;
  atrasos: number | null;
  total_atrasos: string | null;
  status: string | null;
  atualizado_em: Date | null;
}

export async function GET(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const hoje = new Date();
      const mesParam = searchParams.get('mes');
      const anoParam = searchParams.get('ano');
      const mes = mesParam ? parseInt(mesParam, 10) : hoje.getMonth() + 1;
      const ano = anoParam ? parseInt(anoParam, 10) : hoje.getFullYear();

      if (isNaN(mes) || mes < 1 || mes > 12) {
        return errorResponse('Parâmetro `mes` deve ser entre 1 e 12', 400);
      }
      if (isNaN(ano) || ano < 2020 || ano > 2100) {
        return errorResponse('Parâmetro `ano` inválido', 400);
      }

      // Escopo do gestor.
      const escopo = await obterEscopoGestor(user.userId);
      const ehSuperAdmin = isSuperAdmin(user);

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
          mes,
          ano,
          escopo: {
            departamentoIds: escopo.departamentoIds,
            empresaIds: escopo.empresaIds,
            ehSuperAdmin,
          },
          totalColaboradores: 0,
          colaboradores: [],
        });
      }

      // Carrega dados básicos.
      const colabResult = await query<ColabRow>(
        `SELECT c.id, c.nome, c.foto_url,
                c.cargo_id, cg.nome AS cargo_nome,
                c.departamento_id, d.nome AS departamento_nome
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
           LEFT JOIN people.departamentos d ON d.id = c.departamento_id
          WHERE c.id = ANY($1::int[]) AND c.status = 'ativo'
          ORDER BY c.nome ASC`,
        [colaboradorIds],
      );

      // Lê relatórios já calculados — se não existir, devolve zeros.
      // A tabela é populada sob demanda quando alguém abre o relatório
      // mensal individual de um colaborador. Aqui só lê (não dispara cálculo
      // — caro pra fazer N consultas em batch).
      const relatorios = new Map<number, RelatorioRow>();
      try {
        const relResult = await query<RelatorioRow>(
          `SELECT colaborador_id, dias_trabalhados, horas_trabalhadas,
                  horas_extras, banco_horas, faltas, atrasos, total_atrasos,
                  status, atualizado_em
             FROM people.relatorios_mensais
            WHERE colaborador_id = ANY($1::int[])
              AND mes = $2 AND ano = $3`,
          [colaboradorIds, mes, ano],
        );
        for (const r of relResult.rows) {
          relatorios.set(r.colaborador_id, r);
        }
      } catch (e) {
        // Tabela pode não existir ainda em ambientes sem o módulo de
        // relatório mensal ativado — degrada gracefully com tudo zerado.
        console.warn('[equipe-resumo-mensal] tabela relatorios_mensais indisponível:', e);
      }

      const colaboradores = colabResult.rows.map((c) => {
        const r = relatorios.get(c.id);
        return {
          id: c.id,
          nome: c.nome,
          foto: c.foto_url,
          cargo: c.cargo_id ? { id: c.cargo_id, nome: c.cargo_nome ?? '' } : null,
          departamento: c.departamento_id
            ? { id: c.departamento_id, nome: c.departamento_nome ?? '' }
            : null,
          temRelatorio: r != null,
          status: r?.status ?? null,
          diasTrabalhados: r?.dias_trabalhados ?? 0,
          horasTrabalhadas: r?.horas_trabalhadas ?? '00:00',
          horasExtras: r?.horas_extras ?? '00:00',
          bancoHoras: r?.banco_horas ?? '+00:00',
          faltas: r?.faltas ?? 0,
          atrasos: r?.atrasos ?? 0,
          totalAtrasos: r?.total_atrasos ?? '00:00',
          atualizadoEm: r?.atualizado_em ?? null,
        };
      });

      return successResponse({
        mes,
        ano,
        escopo: {
          departamentoIds: escopo.departamentoIds,
          empresaIds: escopo.empresaIds,
          ehSuperAdmin,
        },
        totalColaboradores: colaboradores.length,
        colaboradores,
      });
    } catch (error) {
      console.error('[jornadas/equipe-resumo-mensal] erro:', error);
      return serverErrorResponse('Erro ao listar resumo mensal da equipe');
    }
  });
}
