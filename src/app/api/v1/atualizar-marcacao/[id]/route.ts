import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarMarcacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateMarcacaoCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const marcacaoId = parseInt(id);

      if (isNaN(marcacaoId)) {
        return notFoundResponse('Marcação não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarMarcacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Buscar marcação atual
      const atualResult = await query(
        `SELECT m.*, c.nome as colaborador_nome 
         FROM bluepoint.bt_marcacoes m
         JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id
         WHERE m.id = $1`,
        [marcacaoId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Marcação não encontrada');
      }

      const dadosAnteriores = atualResult.rows[0];

      // Atualizar marcação
      const campos = [
        'data_hora = $1',
        'observacao = $2',
        'justificativa = $3',
        'atualizado_em = NOW()',
      ];
      const valores: (string | null)[] = [data.dataHora, data.observacao || null, data.justificativa];

      if (data.tipo) {
        campos.push(`tipo = $${valores.length + 1}`);
        valores.push(data.tipo);
      }

      valores.push(marcacaoId as unknown as string);

      await query(
        `UPDATE bluepoint.bt_marcacoes SET
          ${campos.join(', ')}
        WHERE id = $${valores.length}`,
        valores
      );

      // Invalidar cache de marcações
      await invalidateMarcacaoCache(dadosAnteriores.colaborador_id);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'marcacoes',
        descricao: `Marcação atualizada: ${dadosAnteriores.colaborador_nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: {
          id: marcacaoId,
          dataHora: dadosAnteriores.data_hora,
          tipo: dadosAnteriores.tipo,
          observacao: dadosAnteriores.observacao,
        },
        dadosNovos: {
          id: marcacaoId,
          dataHora: data.dataHora,
          tipo: data.tipo || dadosAnteriores.tipo,
          observacao: data.observacao,
        },
      });

      return successResponse({
        id: marcacaoId,
        mensagem: 'Marcação atualizada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar marcação:', error);
      return serverErrorResponse('Erro ao atualizar marcação');
    }
  });
}
