import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarJornadaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { calcularCargaHoraria } from '@/lib/utils';
import { invalidateJornadaCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const { id } = await params;
      const jornadaId = parseInt(id);

      if (isNaN(jornadaId)) {
        return notFoundResponse('Jornada não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarJornadaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      await client.query('BEGIN');

      // Verificar se jornada existe
      const jornadaResult = await client.query(
        `SELECT * FROM bluepoint.bt_jornadas WHERE id = $1`,
        [jornadaId]
      );

      if (jornadaResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFoundResponse('Jornada não encontrada');
      }

      const jornadaAnterior = jornadaResult.rows[0];

      // Determinar tipo da jornada
      const tipo = data.tipo || jornadaAnterior.tipo || 'simples';
      const diasRepeticao = data.diasRepeticao ?? jornadaAnterior.dias_repeticao;

      // Calcular nova carga horária se horários foram atualizados
      let cargaHorariaSemanal = parseFloat(jornadaAnterior.carga_horaria_semanal || 0);
      if (data.horarios && data.horarios.length > 0) {
        cargaHorariaSemanal = 0;
        for (const h of data.horarios) {
          if (!h.folga) {
            const horasDia = calcularCargaHoraria(h.periodos || [], h.folga);
            if (tipo === 'circular' && diasRepeticao) {
              cargaHorariaSemanal = horasDia * (7 / diasRepeticao);
            } else {
              cargaHorariaSemanal += horasDia;
            }
          }
        }

        // Remover horários antigos e inserir novos
        await client.query(`DELETE FROM bluepoint.bt_jornada_horarios WHERE jornada_id = $1`, [jornadaId]);
        
        for (const h of data.horarios) {
          await client.query(
            `INSERT INTO bluepoint.bt_jornada_horarios (jornada_id, dia_semana, sequencia, quantidade_dias, dias_semana, periodos, folga)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              jornadaId, 
              h.diaSemana ?? null,
              h.sequencia ?? null,
              h.quantidadeDias || 1,
              JSON.stringify(h.diasSemana || []),
              JSON.stringify(h.periodos || []),
              h.folga || false
            ]
          );
        }
      }

      // Atualizar jornada
      await client.query(
        `UPDATE bluepoint.bt_jornadas SET
          nome = COALESCE($1, nome),
          descricao = COALESCE($2, descricao),
          tipo = COALESCE($3, tipo),
          dias_repeticao = $4,
          carga_horaria_semanal = $5,
          tolerancia_entrada = COALESCE($6, tolerancia_entrada),
          tolerancia_saida = COALESCE($7, tolerancia_saida),
          atualizado_em = NOW()
        WHERE id = $8`,
        [data.nome, data.descricao, data.tipo, diasRepeticao, cargaHorariaSemanal, data.toleranciaEntrada, data.toleranciaSaida, jornadaId]
      );

      await client.query('COMMIT');

      await invalidateJornadaCache(jornadaId);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'jornadas',
        descricao: `Jornada atualizada: ${data.nome || jornadaAnterior.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: jornadaId, nome: jornadaAnterior.nome },
        dadosNovos: { id: jornadaId, ...data },
      });

      return successResponse({
        id: jornadaId,
        mensagem: 'Jornada atualizada com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao atualizar jornada:', error);
      return serverErrorResponse('Erro ao atualizar jornada');
    } finally {
      client.release();
    }
  });
}
