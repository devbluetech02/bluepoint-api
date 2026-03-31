import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withGestor(request, async () => {
    try {
      const { id } = await params;
      const pendenciaId = parseInt(id, 10);

      if (isNaN(pendenciaId)) {
        return notFoundResponse('Pendência não encontrada');
      }

      const cacheKey = `${CACHE_KEYS.PENDENCIA}${pendenciaId}`;
      const dados = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT
            p.*,
            d.nome AS destinatario_nome,
            dep.nome AS departamento_nome,
            c.nome AS criada_por_nome,
            r.nome AS resolvida_por_nome
          FROM people.pendencias p
          LEFT JOIN people.colaboradores d ON p.destinatario_id = d.id
          LEFT JOIN people.departamentos dep ON p.departamento_id = dep.id
          LEFT JOIN people.colaboradores c ON p.criada_por_id = c.id
          LEFT JOIN people.colaboradores r ON p.resolvida_por_id = r.id
          WHERE p.id = $1`,
          [pendenciaId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        const historicoResult = await query(
          `SELECT h.*, u.nome AS usuario_nome
           FROM people.pendencias_historico h
           LEFT JOIN people.colaboradores u ON h.usuario_id = u.id
           WHERE h.pendencia_id = $1
           ORDER BY h.criado_em`,
          [pendenciaId]
        );

        return {
          id: row.id,
          titulo: row.titulo,
          descricao: row.descricao,
          tipo: row.tipo,
          status: row.status,
          prioridade: row.prioridade,
          origem: row.origem,
          dataLimite: row.data_limite,
          resolvidoEm: row.resolvido_em,
          observacaoResolucao: row.observacao_resolucao,
          dadosAdicionais: row.dados_adicionais,
          criadoEm: row.criado_em,
          atualizadoEm: row.atualizado_em,
          destinatario: row.destinatario_id
            ? { id: row.destinatario_id, nome: row.destinatario_nome }
            : null,
          departamento: row.departamento_id
            ? { id: row.departamento_id, nome: row.departamento_nome }
            : null,
          criadaPor: row.criada_por_id
            ? { id: row.criada_por_id, nome: row.criada_por_nome }
            : null,
          resolvidaPor: row.resolvida_por_id
            ? { id: row.resolvida_por_id, nome: row.resolvida_por_nome }
            : null,
          historicoStatus: historicoResult.rows.map((h) => ({
            statusAnterior: h.status_anterior,
            statusNovo: h.status_novo,
            usuario: h.usuario_nome,
            observacao: h.observacao,
            data: h.criado_em,
          })),
        };
      }, CACHE_TTL.SHORT);

      if (!dados) {
        return notFoundResponse('Pendência não encontrada');
      }

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter pendência:', error);
      return serverErrorResponse('Erro ao obter pendência');
    }
  });
}
