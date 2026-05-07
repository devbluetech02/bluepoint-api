import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { solicitarAjustePontoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(solicitarAjustePontoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Apenas itens que apontam pra marcação existente são verificados.
      // Itens com marcacaoId null = ajuste por AUSÊNCIA (colaborador não bateu ponto):
      // exigem `tipo` e ficam só no JSON, sem cross-check.
      const marcacaoIds = data.ajustes
        .map((a) => a.marcacaoId)
        .filter((id): id is number => typeof id === 'number');

      const marcacoesMap = new Map<number, { id: number; data_hora: Date }>();
      if (marcacaoIds.length > 0) {
        const marcacoesResult = await query<{ id: number; data_hora: Date }>(
          `SELECT id, data_hora FROM people.marcacoes WHERE id = ANY($1) AND colaborador_id = $2`,
          [marcacaoIds, user.userId]
        );

        if (marcacoesResult.rows.length !== marcacaoIds.length) {
          const encontrados = marcacoesResult.rows.map((r) => r.id);
          const naoEncontrados = marcacaoIds.filter((id) => !encontrados.includes(id));
          return errorResponse(`Marcação(ões) não encontrada(s): ${naoEncontrados.join(', ')}`, 404);
        }

        for (const r of marcacoesResult.rows) marcacoesMap.set(r.id, r);
      }

      // Montar dados de cada ajuste com horário original (quando aplicável).
      const ajustesComOriginal = data.ajustes.map((a) => ({
        marcacaoId: a.marcacaoId ?? null,
        tipo: a.tipo ?? null,
        dataHoraCorreta: a.dataHoraCorreta,
        dataHoraOriginal:
          a.marcacaoId != null ? marcacoesMap.get(a.marcacaoId)?.data_hora ?? null : null,
      }));

      // data_evento: prioriza data da 1ª marcação existente; cai pra dataHoraCorreta
      // do 1º item quando todos forem ajustes por ausência.
      const primeiraComMarcacao = data.ajustes.find((a) => a.marcacaoId != null);
      const primeiraData =
        (primeiraComMarcacao?.marcacaoId != null
          ? marcacoesMap.get(primeiraComMarcacao.marcacaoId)?.data_hora
          : null) ?? new Date(data.ajustes[0].dataHoraCorreta);

      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO solicitacoes (
          colaborador_id, tipo, data_evento, descricao, justificativa, dados_adicionais
        ) VALUES ($1, 'ajuste_ponto', $2, $3, $4, $5)
        RETURNING id`,
        [
          user.userId,
          primeiraData,
          data.motivo,
          data.justificativa,
          JSON.stringify({ ajustes: ajustesComOriginal }),
        ]
      );

      const solicitacaoId = result.rows[0].id;

      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', $2, $3)`,
        [solicitacaoId, user.userId, `Solicitação de ajuste de ponto criada (${data.ajustes.length} marcação(ões))`]
      );

      await client.query('COMMIT');

      // Invalida cache da listagem (gestores precisam ver imediatamente).
      cacheDelPattern(`${CACHE_KEYS.SOLICITACOES}*`).catch((e) =>
        console.error('Falha ao invalidar cache de solicitações:', e),
      );

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'solicitacoes',
        descricao: `Solicitação de ajuste de ponto criada (${data.ajustes.length} marcação(ões))`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return createdResponse({
        solicitacaoId,
        status: 'pendente',
        totalAjustes: data.ajustes.length,
        mensagem: `Solicitação de ajuste de ponto criada com sucesso (${data.ajustes.length} marcação(ões))`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao solicitar ajuste de ponto:', error);
      return serverErrorResponse('Erro ao criar solicitação');
    } finally {
      client.release();
    }
  });
}
