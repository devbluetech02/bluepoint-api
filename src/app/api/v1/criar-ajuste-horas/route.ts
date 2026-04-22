import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarAjusteHorasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { criarNotificacaoComPush } from '@/lib/notificacoes';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarAjusteHorasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1 AND status = 'ativo'`,
        [data.colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      const colaborador = colaboradorResult.rows[0];

      // Buscar saldo atual
      const saldoResult = await query(
        `SELECT saldo_atual FROM banco_horas
         WHERE colaborador_id = $1
         ORDER BY criado_em DESC
         LIMIT 1`,
        [data.colaboradorId]
      );

      const saldoAnterior = saldoResult.rows.length > 0 ? parseFloat(saldoResult.rows[0].saldo_atual) : 0;
      
      // Calcular novo saldo
      const horas = data.tipo === 'debito' ? -data.horas : data.horas;
      const saldoAtual = saldoAnterior + horas;

      // Inserir ajuste
      const result = await query(
        `INSERT INTO banco_horas (
          colaborador_id, data, tipo, descricao, horas, saldo_anterior, saldo_atual, observacao, criado_por
        ) VALUES ($1, $2, 'ajuste', $3, $4, $5, $6, $7, $8)
        RETURNING id`,
        [
          data.colaboradorId,
          data.data,
          data.motivo,
          horas,
          saldoAnterior,
          saldoAtual,
          data.observacao || null,
          user.userId,
        ]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'banco_horas',
        descricao: `Ajuste de horas criado para ${colaborador.nome}: ${data.tipo} ${data.horas}h`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          id: result.rows[0].id,
          colaboradorId: data.colaboradorId,
          tipo: data.tipo,
          horas: data.horas,
          saldoAtual,
        },
      });

      // Formatar horas para exibição (ex: +2h30min)
      const horasAbs = Math.abs(horas);
      const h = Math.floor(horasAbs);
      const min = Math.round((horasAbs - h) * 60);
      const sinal = horas >= 0 ? '+' : '-';
      const horasFormatadas = min > 0 ? `${sinal}${h}h${min}min` : `${sinal}${h}h`;
      const saldoAbs = Math.abs(saldoAtual);
      const sh = Math.floor(saldoAbs);
      const smin = Math.round((saldoAbs - sh) * 60);
      const ssinal = saldoAtual >= 0 ? '+' : '-';
      const saldoFormatado = smin > 0 ? `${ssinal}${sh}h${smin}min` : `${ssinal}${sh}h`;

      criarNotificacaoComPush({
        usuarioId: data.colaboradorId,
        tipo: 'sistema',
        titulo: 'Banco de horas ajustado',
        mensagem: `Seu banco de horas foi ajustado: ${horasFormatadas}${data.motivo ? ` (${data.motivo})` : ''}. Novo saldo: ${saldoFormatado}.`,
        link: '/banco-horas',
        metadados: { acao: 'ajuste_horas', tipo: data.tipo, horas, saldoAtual },
        pushSeveridade: saldoAtual < 0 ? 'atencao' : 'info',
      }).catch((err) => console.error('[Notificação] Erro ao notificar ajuste de horas:', err));

      return createdResponse({
        id: result.rows[0].id,
        saldoAtualizado: saldoAtual,
        mensagem: 'Ajuste de horas criado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar ajuste de horas:', error);
      return serverErrorResponse('Erro ao criar ajuste');
    }
  });
}
