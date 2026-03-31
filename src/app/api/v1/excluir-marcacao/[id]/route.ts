import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { noContentResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateMarcacaoCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const marcacaoId = parseInt(id);

      if (isNaN(marcacaoId)) {
        return notFoundResponse('Marcação não encontrada');
      }

      const body = await req.json();
      const { justificativa } = body;

      if (!justificativa) {
        return errorResponse('Justificativa é obrigatória para exclusão', 400);
      }

      // Buscar marcação
      const result = await query(
        `SELECT m.*, c.nome as colaborador_nome 
         FROM people.marcacoes m
         JOIN people.colaboradores c ON m.colaborador_id = c.id
         WHERE m.id = $1`,
        [marcacaoId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Marcação não encontrada');
      }

      const marcacao = result.rows[0];

      // Excluir marcação
      await query(`DELETE FROM people.marcacoes WHERE id = $1`, [marcacaoId]);

      // Invalidar cache de marcações
      await invalidateMarcacaoCache(marcacao.colaborador_id);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'marcacoes',
        descricao: `Marcação excluída: ${marcacao.colaborador_nome} - ${marcacao.tipo} em ${marcacao.data_hora}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: {
          id: marcacaoId,
          colaboradorId: marcacao.colaborador_id,
          dataHora: marcacao.data_hora,
          tipo: marcacao.tipo,
        },
        metadados: { justificativa },
      });

      return noContentResponse();
    } catch (error) {
      console.error('Erro ao excluir marcação:', error);
      return serverErrorResponse('Erro ao excluir marcação');
    }
  });
}
