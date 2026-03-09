import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarGestaoPessoasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateGestaoPessoasCache } from '@/lib/cache';
import { deletarArquivo } from '@/lib/storage';
import {
  formatRegistro,
  fetchAnexosPorRegistros,
  fetchReunioesComParticipantes,
} from '@/lib/gestao-pessoas';

interface Params {
  params: Promise<{ id: string }>;
}

// =====================================================
// GET  /api/v1/gestao-pessoas/:id
// =====================================================

export async function GET(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const registroId = parseInt(id);
      if (isNaN(registroId)) return notFoundResponse('Registro não encontrado');

      const result = await query(
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
         WHERE gp.id = $1`,
        [registroId]
      );

      if (result.rows.length === 0) return notFoundResponse('Registro não encontrado');

      const [anexosMap, reunioesMap] = await Promise.all([
        fetchAnexosPorRegistros([registroId]),
        fetchReunioesComParticipantes([registroId]),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = result.rows[0] as any;
      const registro = formatRegistro(row, anexosMap.get(registroId) || [], reunioesMap.get(registroId) || null);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'visualizar',
        modulo: 'gestao_pessoas',
        descricao: `Registro #${registroId} visualizado`,
        entidadeId: registroId,
        entidadeTipo: 'gestao_pessoas',
      }));

      return successResponse(registro);
    } catch (error) {
      console.error('Erro ao obter registro de gestão de pessoas:', error);
      return serverErrorResponse('Erro ao obter registro');
    }
  });
}

// =====================================================
// PUT  /api/v1/gestao-pessoas/:id
// =====================================================

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    const dbClient = await getClient();
    try {
      const { id } = await params;
      const registroId = parseInt(id);
      if (isNaN(registroId)) return notFoundResponse('Registro não encontrado');

      const body = await req.json();
      const validation = validateBody(atualizarGestaoPessoasSchema, body);
      if (!validation.success) return validationErrorResponse(validation.errors);

      const data = validation.data;

      const atualResult = await query(
        `SELECT gp.*, r.nome AS responsavel_nome
         FROM bluepoint.bt_gestao_pessoas gp
         JOIN bluepoint.bt_colaboradores r ON gp.responsavel_id = r.id
         WHERE gp.id = $1`,
        [registroId]
      );
      if (atualResult.rows.length === 0) return notFoundResponse('Registro não encontrado');

      const dadosAnteriores = atualResult.rows[0];

      await dbClient.query('BEGIN');

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      const fieldsMap: Record<string, string> = {
        status: 'status',
        titulo: 'titulo',
        descricao: 'descricao',
      };

      for (const [jsField, dbField] of Object.entries(fieldsMap)) {
        if (data[jsField as keyof typeof data] !== undefined) {
          setClauses.push(`${dbField} = $${idx}`);
          values.push(data[jsField as keyof typeof data]);
          idx++;
        }
      }

      if (data.status === 'concluido' && dadosAnteriores.status !== 'concluido') {
        setClauses.push(`data_conclusao = CURRENT_DATE`);
      } else if (data.status && data.status !== 'concluido' && dadosAnteriores.data_conclusao) {
        setClauses.push(`data_conclusao = NULL`);
      }

      if (setClauses.length > 0) {
        setClauses.push('atualizado_em = NOW()');
        values.push(registroId);
        await dbClient.query(
          `UPDATE bluepoint.bt_gestao_pessoas SET ${setClauses.join(', ')} WHERE id = $${idx}`,
          values
        );
      }

      const hasReuniaoUpdate = data.reuniaoData || data.reuniaoHora || data.reuniaoStatus || data.reuniaoObservacoes !== undefined;
      if (hasReuniaoUpdate || data.participantesIds) {
        const reuniaoExists = await dbClient.query(
          `SELECT id FROM bluepoint.bt_gestao_pessoas_reunioes WHERE gestao_pessoa_id = $1`,
          [registroId]
        );

        if (reuniaoExists.rows.length > 0) {
          const reuniaoId = reuniaoExists.rows[0].id;

          if (hasReuniaoUpdate) {
            const rClauses: string[] = [];
            const rValues: unknown[] = [];
            let rIdx = 1;

            if (data.reuniaoData) {
              rClauses.push(`data = $${rIdx}`); rValues.push(data.reuniaoData); rIdx++;
            }
            if (data.reuniaoHora) {
              rClauses.push(`hora = $${rIdx}`); rValues.push(data.reuniaoHora); rIdx++;
            }
            if (data.reuniaoStatus) {
              rClauses.push(`status = $${rIdx}`); rValues.push(data.reuniaoStatus); rIdx++;
            }
            if (data.reuniaoObservacoes !== undefined) {
              rClauses.push(`observacoes = $${rIdx}`); rValues.push(data.reuniaoObservacoes); rIdx++;
            }

            if (rClauses.length > 0) {
              rClauses.push('atualizado_em = NOW()');
              rValues.push(reuniaoId);
              await dbClient.query(
                `UPDATE bluepoint.bt_gestao_pessoas_reunioes SET ${rClauses.join(', ')} WHERE id = $${rIdx}`,
                rValues
              );
            }
          }

          if (data.participantesIds) {
            await dbClient.query(
              `DELETE FROM bluepoint.bt_gestao_pessoas_participantes WHERE reuniao_id = $1`,
              [reuniaoId]
            );
            for (const pId of data.participantesIds) {
              await dbClient.query(
                `INSERT INTO bluepoint.bt_gestao_pessoas_participantes (reuniao_id, colaborador_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [reuniaoId, pId]
              );
            }
          }
        }
      }

      await dbClient.query('COMMIT');

      await invalidateGestaoPessoasCache(registroId);

      const updatedResult = await query(
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
         WHERE gp.id = $1`,
        [registroId]
      );

      const [anexosMap, reunioesMap] = await Promise.all([
        fetchAnexosPorRegistros([registroId]),
        fetchReunioesComParticipantes([registroId]),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = updatedResult.rows[0] as any;
      const registro = formatRegistro(row, anexosMap.get(registroId) || [], reunioesMap.get(registroId) || null);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'gestao_pessoas',
        descricao: `Registro #${registroId} atualizado`,
        entidadeId: registroId,
        entidadeTipo: 'gestao_pessoas',
        dadosAnteriores: { id: registroId, ...dadosAnteriores },
        dadosNovos: { id: registroId, ...data },
      }));

      return successResponse(registro);
    } catch (error) {
      await dbClient.query('ROLLBACK').catch(() => {});
      console.error('Erro ao atualizar registro de gestão de pessoas:', error);
      return serverErrorResponse('Erro ao atualizar registro');
    } finally {
      dbClient.release();
    }
  });
}

// =====================================================
// DELETE /api/v1/gestao-pessoas/:id
// =====================================================

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const registroId = parseInt(id);
      if (isNaN(registroId)) return notFoundResponse('Registro não encontrado');

      const result = await query(
        `SELECT gp.id, gp.titulo, gp.tipo, c.nome AS colaborador_nome
         FROM bluepoint.bt_gestao_pessoas gp
         JOIN bluepoint.bt_colaboradores c ON gp.colaborador_id = c.id
         WHERE gp.id = $1`,
        [registroId]
      );
      if (result.rows.length === 0) return notFoundResponse('Registro não encontrado');

      const registro = result.rows[0];

      const anexosResult = await query(
        `SELECT caminho_storage FROM bluepoint.bt_gestao_pessoas_anexos WHERE gestao_pessoa_id = $1`,
        [registroId]
      );
      for (const row of anexosResult.rows) {
        await deletarArquivo((row as { caminho_storage: string }).caminho_storage).catch(() => {});
      }

      await query(`DELETE FROM bluepoint.bt_gestao_pessoas WHERE id = $1`, [registroId]);

      await invalidateGestaoPessoasCache(registroId);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'excluir',
        modulo: 'gestao_pessoas',
        descricao: `Registro #${registroId} excluído: ${registro.titulo}`,
        entidadeId: registroId,
        entidadeTipo: 'gestao_pessoas',
        dadosAnteriores: { id: registroId, titulo: registro.titulo, tipo: registro.tipo },
      }));

      return successResponse({ message: 'Registro excluído com sucesso' });
    } catch (error) {
      console.error('Erro ao excluir registro de gestão de pessoas:', error);
      return serverErrorResponse('Erro ao excluir registro');
    }
  });
}
