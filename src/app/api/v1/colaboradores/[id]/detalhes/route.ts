import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';

// GET /api/v1/colaboradores/:id/detalhes?dias=7
//
// Retorna em UMA chamada o painel de detalhes que o gestor abre ao
// tocar num colaborador na tela de Jornadas:
//   - Dados básicos (nome, foto, cargo, departamento, empresa, jornada,
//     data de admissão, status, e-mail / telefone)
//   - Marcações dos últimos N dias (default 7), agrupadas por dia
//   - Solicitações recentes (últimas 20)
//
// Acesso: super admin, próprio, ou gestor com escopo (via
// asseguraAcessoColaborador).

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id, 10);
      if (Number.isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Validar acesso (privacidade: colaborador só vê o próprio,
      // gestor só vê quem está no escopo).
      const acesso = await asseguraAcessoColaborador(user, colaboradorId);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      const { searchParams } = new URL(req.url);
      const diasRaw = searchParams.get('dias');
      const dias = Math.max(1, Math.min(60, parseInt(diasRaw ?? '7', 10) || 7));

      // 1. Dados básicos do colaborador
      const colabResult = await query<{
        id: number;
        nome: string;
        email: string;
        cpf: string | null;
        telefone: string | null;
        foto_url: string | null;
        status: string;
        data_admissao: Date | null;
        cargo_id: number | null;
        cargo_nome: string | null;
        departamento_id: number | null;
        departamento_nome: string | null;
        empresa_id: number | null;
        empresa_nome: string | null;
        empresa_razao: string | null;
        jornada_id: number | null;
        jornada_nome: string | null;
        carga_horaria_semanal: string | null;
      }>(
        `SELECT c.id, c.nome, c.email, c.cpf, c.telefone, c.foto_url,
                c.status::text AS status, c.data_admissao,
                c.cargo_id, cg.nome AS cargo_nome,
                c.departamento_id, d.nome AS departamento_nome,
                c.empresa_id, e.nome_fantasia AS empresa_nome, e.razao_social AS empresa_razao,
                c.jornada_id, j.nome AS jornada_nome, j.carga_horaria_semanal::text AS carga_horaria_semanal
           FROM people.colaboradores c
           LEFT JOIN people.cargos cg        ON cg.id = c.cargo_id
           LEFT JOIN people.departamentos d  ON d.id  = c.departamento_id
           LEFT JOIN people.empresas e       ON e.id  = c.empresa_id
           LEFT JOIN people.jornadas j       ON j.id  = c.jornada_id
          WHERE c.id = $1 LIMIT 1`,
        [colaboradorId],
      );

      const colab = colabResult.rows[0];
      if (!colab) return notFoundResponse('Colaborador não encontrado');

      // 2. Marcações dos últimos `dias`
      const margResult = await query<{
        id: number;
        data_hora: Date;
        tipo: string;
        metodo: string | null;
      }>(
        `SELECT id, data_hora, tipo, metodo
           FROM people.marcacoes
          WHERE colaborador_id = $1
            AND data_hora >= (CURRENT_DATE - ($2::int * interval '1 day'))
          ORDER BY data_hora DESC`,
        [colaboradorId, dias],
      );

      // Agrupa marcações por dia (YYYY-MM-DD) pra render simples no app.
      const grupoPorDia = new Map<
        string,
        Array<{
          id: number;
          dataHora: Date;
          tipo: string;
          metodo: string | null;
        }>
      >();
      for (const m of margResult.rows) {
        const dia = m.data_hora.toISOString().slice(0, 10);
        const lista = grupoPorDia.get(dia) ?? [];
        lista.push({
          id: m.id,
          dataHora: m.data_hora,
          tipo: m.tipo,
          metodo: m.metodo,
        });
        grupoPorDia.set(dia, lista);
      }
      const marcacoesPorDia = Array.from(grupoPorDia.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([data, marcacoes]) => ({
          data,
          // Cada dia já vem em ordem decrescente; reverte pra ASC dentro do
          // dia (cronológico — entrada → almoço → retorno → saída).
          marcacoes: [...marcacoes].reverse(),
        }));

      // 3. Solicitações recentes (últimas 20 — qualquer status)
      const solicResult = await query<{
        id: number;
        tipo: string;
        status: string;
        data_solicitacao: Date;
        data_evento: Date | null;
        descricao: string | null;
        gestor_nome: string | null;
        aprovador_nome: string | null;
        motivo_rejeicao: string | null;
      }>(
        `SELECT s.id, s.tipo::text, s.status::text, s.data_solicitacao, s.data_evento,
                s.descricao, s.motivo_rejeicao,
                g.nome AS gestor_nome, a.nome AS aprovador_nome
           FROM solicitacoes s
           LEFT JOIN people.colaboradores g ON g.id = s.gestor_id
           LEFT JOIN people.colaboradores a ON a.id = s.aprovador_id
          WHERE s.colaborador_id = $1
          ORDER BY s.data_solicitacao DESC
          LIMIT 20`,
        [colaboradorId],
      ).catch((e) => {
        // Defesa: se a tabela `solicitacoes` mudar shape, não derruba o
        // payload todo — devolve lista vazia e log no servidor.
        console.warn('[colaboradores/:id/detalhes] falha ao listar solicitações:', e);
        return { rows: [] as Array<{
          id: number;
          tipo: string;
          status: string;
          data_solicitacao: Date;
          data_evento: Date | null;
          descricao: string | null;
          gestor_nome: string | null;
          aprovador_nome: string | null;
          motivo_rejeicao: string | null;
        }> };
      });

      const solicitacoes = solicResult.rows.map((s) => ({
        id: s.id,
        tipo: s.tipo,
        status: s.status,
        dataSolicitacao: s.data_solicitacao,
        dataEvento: s.data_evento,
        descricao: s.descricao,
        gestorNome: s.gestor_nome,
        aprovadorNome: s.aprovador_nome,
        motivoRejeicao: s.motivo_rejeicao,
      }));

      // Resumo derivado pra exibir cards no topo da tela do app
      const totalMarcacoes = margResult.rows.length;
      const solicitacoesPendentes = solicitacoes.filter((s) => s.status === 'pendente').length;
      const ultimaMarcacao = margResult.rows[0]?.data_hora ?? null;

      return successResponse({
        colaborador: {
          id: colab.id,
          nome: colab.nome,
          email: colab.email,
          cpf: colab.cpf,
          telefone: colab.telefone,
          foto: colab.foto_url,
          status: colab.status,
          dataAdmissao: colab.data_admissao,
          cargo: colab.cargo_id
            ? { id: colab.cargo_id, nome: colab.cargo_nome ?? '' }
            : null,
          departamento: colab.departamento_id
            ? { id: colab.departamento_id, nome: colab.departamento_nome ?? '' }
            : null,
          empresa: colab.empresa_id
            ? {
                id: colab.empresa_id,
                nome: colab.empresa_nome || colab.empresa_razao || '',
              }
            : null,
          jornada: colab.jornada_id
            ? {
                id: colab.jornada_id,
                nome: colab.jornada_nome ?? '',
                cargaHorariaSemanal: colab.carga_horaria_semanal
                  ? parseFloat(colab.carga_horaria_semanal)
                  : null,
              }
            : null,
        },
        resumo: {
          dias,
          totalMarcacoes,
          ultimaMarcacao,
          solicitacoesPendentes,
          totalSolicitacoes: solicitacoes.length,
        },
        marcacoesPorDia,
        solicitacoes,
      });
    } catch (error) {
      console.error('[colaboradores/:id/detalhes] erro:', error);
      return serverErrorResponse('Erro ao obter detalhes do colaborador');
    }
  });
}
