import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.SOLICITACAO}${solicitacaoId}`;

      const dados = await cacheAside(cacheKey, async () => {

      const result = await query(
        `SELECT 
          s.*,
          c.id as colaborador_id,
          c.nome as colaborador_nome,
          c.email as colaborador_email,
          a.id as aprovador_id,
          a.nome as aprovador_nome,
          g.id as gestor_id,
          g.nome as gestor_nome
        FROM solicitacoes s
        JOIN people.colaboradores c ON s.colaborador_id = c.id
        LEFT JOIN people.colaboradores a ON s.aprovador_id = a.id
        LEFT JOIN people.colaboradores g ON s.gestor_id = g.id
        WHERE s.id = $1`,
        [solicitacaoId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Buscar anexos
      const anexosResult = await query(
        `SELECT id, tipo, nome, url, tamanho, data_upload
         FROM anexos
         WHERE solicitacao_id = $1
         ORDER BY data_upload`,
        [solicitacaoId]
      );

      // Buscar histórico de status
      const historicoResult = await query(
        `SELECT sh.*, u.nome as usuario_nome
         FROM solicitacoes_historico sh
         LEFT JOIN people.colaboradores u ON sh.usuario_id = u.id
         WHERE sh.solicitacao_id = $1
         ORDER BY sh.criado_em`,
        [solicitacaoId]
      );

      return {
        id: row.id,
        colaborador: {
          id: row.colaborador_id,
          nome: row.colaborador_nome,
          email: row.colaborador_email,
        },
        tipo: row.tipo,
        status: row.status,
        dataSolicitacao: row.data_solicitacao,
        dataEvento: row.data_evento,
        dataEventoFim: row.data_evento_fim ?? undefined,
        descricao: row.descricao,
        justificativa: row.justificativa,
        dadosAdicionais: row.dados_adicionais,
        gestor: row.gestor_id ? { id: row.gestor_id, nome: row.gestor_nome } : null,
        anexos: anexosResult.rows.map(a => ({
          id: a.id,
          tipo: a.tipo,
          nome: a.nome,
          url: a.url,
          tamanho: a.tamanho,
          dataUpload: a.data_upload,
        })),
        aprovador: row.aprovador_id ? { id: row.aprovador_id, nome: row.aprovador_nome } : null,
        dataAprovacao: row.data_aprovacao,
        motivoRejeicao: row.motivo_rejeicao,
        historicoStatus: historicoResult.rows.map(h => ({
          statusAnterior: h.status_anterior,
          statusNovo: h.status_novo,
          usuario: h.usuario_nome,
          observacao: h.observacao,
          data: h.criado_em,
        })),
      };
      }, CACHE_TTL.SHORT);

      if (!dados) {
        return notFoundResponse('Solicitação não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter solicitação:', error);
      return serverErrorResponse('Erro ao obter solicitação');
    }
  });
}
