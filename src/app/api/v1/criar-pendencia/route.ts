import { NextRequest } from 'next/server';
import { getClient, query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor, isApiKeyAuth } from '@/lib/middleware';
import { criarPendenciaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidatePendenciaCache } from '@/lib/cache';
import { criarNotificacao } from '@/lib/notificacoes';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    try {
      const body = await req.json();
      const validation = validateBody(criarPendenciaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      if (data.destinatarioId) {
        const destinatarioExiste = await query(
          `SELECT id
           FROM people.colaboradores
           WHERE id = $1
             AND status = 'ativo'
             AND tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')`,
          [data.destinatarioId]
        );

        if (destinatarioExiste.rows.length === 0) {
          return errorResponse('Destinatário não encontrado, inativo ou sem permissão de gestão', 404);
        }
      }

      if (data.departamentoId) {
        const departamentoExiste = await query(
          `SELECT id FROM people.departamentos WHERE id = $1`,
          [data.departamentoId]
        );
        if (departamentoExiste.rows.length === 0) {
          return errorResponse('Departamento não encontrado', 404);
        }
      }

      await client.query('BEGIN');

      const criadaPorId = isApiKeyAuth(user) ? null : user.userId;
      const result = await client.query(
        `INSERT INTO people.pendencias (
          titulo, descricao, tipo, prioridade, origem,
          destinatario_id, departamento_id, criada_por_id, data_limite, dados_adicionais
        ) VALUES ($1, $2, $3, $4, 'sistema', $5, $6, $7, $8, $9)
        RETURNING id, status, criado_em`,
        [
          data.titulo,
          data.descricao,
          data.tipo,
          data.prioridade,
          data.destinatarioId ?? null,
          data.departamentoId ?? null,
          criadaPorId,
          data.dataLimite ?? null,
          data.dadosAdicionais ? JSON.stringify(data.dadosAdicionais) : null,
        ]
      );

      const pendencia = result.rows[0];

      await client.query(
        `INSERT INTO people.pendencias_historico (pendencia_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, 'Pendência criada pelo sistema')`,
        [pendencia.id, criadaPorId]
      );

      await client.query('COMMIT');

      if (data.destinatarioId) {
        await criarNotificacao({
          usuarioId: data.destinatarioId,
          tipo: 'solicitacao',
          titulo: 'Nova pendência para resolução',
          mensagem: `${data.titulo} - ${data.descricao}`,
          link: `/pendencias/${pendencia.id}`,
          metadados: {
            acao: 'pendencia_criada',
            pendenciaId: pendencia.id,
            prioridade: data.prioridade,
          },
        });
      }

      await invalidatePendenciaCache(pendencia.id, data.destinatarioId ?? undefined);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'pendencias',
        descricao: `Pendência criada: ${data.titulo}`,
        entidadeId: pendencia.id,
        entidadeTipo: 'pendencia',
        dadosNovos: {
          pendenciaId: pendencia.id,
          tipo: data.tipo,
          prioridade: data.prioridade,
          destinatarioId: data.destinatarioId ?? null,
        },
      }));

      return createdResponse({
        id: pendencia.id,
        status: pendencia.status,
        criadoEm: pendencia.criado_em,
        mensagem: 'Pendência criada com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar pendência:', error);
      return serverErrorResponse('Erro ao criar pendência');
    } finally {
      client.release();
    }
  });
}
