import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { buscarParametrosEsportes, calcularProximaDataSessao, obterOuCriarSessaoPorData } from '@/lib/esportes';

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      const parametros = await buscarParametrosEsportes();
      const { proximaData, ehHoje } = await calcularProximaDataSessao(parametros.dia_semana);
      const sessaoId = await obterOuCriarSessaoPorData(proximaData, parametros);

      const inscricoesResult = await query(
        `SELECT i.id, i.colaborador_id, c.nome, d.nome AS departamento, i.posicao, i.confirmado, i.confirmado_em
         FROM bluepoint.bt_esportes_inscricoes i
         JOIN bluepoint.bt_colaboradores c ON c.id = i.colaborador_id
         LEFT JOIN bluepoint.bt_departamentos d ON d.id = c.departamento_id
         WHERE i.sessao_id = $1
         ORDER BY i.id ASC`,
        [sessaoId],
      );

      const inscricoes = inscricoesResult.rows.map((row) => ({
        id: row.id,
        colaborador_id: row.colaborador_id,
        nome: row.nome,
        departamento: row.departamento ?? null,
        posicao: row.posicao,
        confirmado: row.confirmado,
        confirmado_em: row.confirmado_em,
        sou_eu: row.colaborador_id === user.userId,
      }));

      return Response.json({
        data: {
        id: sessaoId,
        data: proximaData,
        eh_hoje: ehHoje,
        hora_inicio: parametros.hora_inicio,
        horas_jogo: parametros.horas_jogo,
        local: parametros.local,
        total_vagas: parametros.total_jogadores,
        inscricoes,
        },
      });
    } catch (error) {
      console.error('Erro ao buscar próxima sessão de esportes:', error);
      return serverErrorResponse('Erro ao buscar próxima sessão de esportes');
    }
  });
}
