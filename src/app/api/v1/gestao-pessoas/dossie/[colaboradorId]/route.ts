import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import {
  formatRegistro,
  fetchAnexosPorRegistros,
  fetchReunioesComParticipantes,
} from '@/lib/gestao-pessoas';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { colaboradorId: colabIdStr } = await params;
      const colaboradorId = parseInt(colabIdStr);
      if (isNaN(colaboradorId)) return notFoundResponse('Colaborador não encontrado');

      const colabResult = await query(
        `SELECT c.id, c.nome, cg.nome AS cargo, d.nome AS departamento
         FROM bluepoint.bt_colaboradores c
         LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
         LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
         WHERE c.id = $1`,
        [colaboradorId]
      );
      if (colabResult.rows.length === 0) return notFoundResponse('Colaborador não encontrado');

      const colab = colabResult.rows[0] as {
        id: number; nome: string; cargo: string | null; departamento: string | null;
      };

      const registrosResult = await query(
        `SELECT
           gp.id, gp.colaborador_id, gp.tipo, gp.status,
           gp.titulo, gp.descricao, gp.data_registro, gp.data_conclusao,
           c.nome AS colaborador_nome,
           cg.nome AS colaborador_cargo,
           d.nome AS colaborador_departamento,
           r.nome AS responsavel_nome
         FROM bluepoint.bt_gestao_pessoas gp
         JOIN bluepoint.bt_colaboradores c ON gp.colaborador_id = c.id
         LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
         LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
         JOIN bluepoint.bt_colaboradores r ON gp.responsavel_id = r.id
         WHERE gp.colaborador_id = $1
         ORDER BY gp.data_registro DESC, gp.id DESC`,
        [colaboradorId]
      );

      const registroIds = registrosResult.rows.map(r => (r as { id: number }).id);
      const [anexosMap, reunioesMap] = await Promise.all([
        fetchAnexosPorRegistros(registroIds),
        fetchReunioesComParticipantes(registroIds),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registros = registrosResult.rows.map((row: any) =>
        formatRegistro(row, anexosMap.get(row.id) || [], reunioesMap.get(row.id) || null)
      );

      const resumoResult = await query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE tipo = 'advertencia') AS advertencias,
           COUNT(*) FILTER (WHERE tipo = 'feedback_positivo') AS feedbacks_positivos,
           COUNT(*) FILTER (WHERE tipo = 'feedback_negativo') AS feedbacks_negativos,
           COUNT(*) FILTER (WHERE tipo = 'demissao') AS demissoes
         FROM bluepoint.bt_gestao_pessoas
         WHERE colaborador_id = $1`,
        [colaboradorId]
      );

      const sr = resumoResult.rows[0];
      const resumo = {
        total: parseInt(sr.total),
        advertencias: parseInt(sr.advertencias),
        feedbacksPositivos: parseInt(sr.feedbacks_positivos),
        feedbacksNegativos: parseInt(sr.feedbacks_negativos),
        demissoes: parseInt(sr.demissoes),
      };

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'visualizar',
        modulo: 'gestao_pessoas',
        descricao: `Dossiê do colaborador ${colab.nome} visualizado`,
        colaboradorId,
        colaboradorNome: colab.nome,
        entidadeId: colaboradorId,
        entidadeTipo: 'colaborador',
      }));

      return successResponse({
        colaborador: {
          id: colab.id,
          nome: colab.nome,
          cargo: colab.cargo,
          departamento: colab.departamento,
        },
        resumo,
        registros,
      });
    } catch (error) {
      console.error('Erro ao obter dossiê do colaborador:', error);
      return serverErrorResponse('Erro ao obter dossiê do colaborador');
    }
  });
}
