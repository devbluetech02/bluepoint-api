import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarJornadaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { calcularCargaHoraria } from '@/lib/utils';
import { invalidateJornadaCache } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(criarJornadaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      await client.query('BEGIN');

      // Calcular carga horária semanal
      let cargaHorariaSemanal = 0;
      for (const h of data.horarios) {
        if (!h.folga) {
          const horasDia = calcularCargaHoraria(h.periodos || [], h.folga);
          // Para circular, multiplica pelo ciclo; para simples, soma direto
          if (data.tipo === 'circular' && data.diasRepeticao) {
            cargaHorariaSemanal = horasDia * (7 / data.diasRepeticao);
          } else {
            cargaHorariaSemanal += horasDia;
          }
        }
      }

      // Inserir jornada
      const jornadaResult = await client.query(
        `INSERT INTO people.jornadas (nome, descricao, tipo, dias_repeticao, carga_horaria_semanal, tolerancia_entrada, tolerancia_saida)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, nome, tipo`,
        [
          data.nome, 
          data.descricao || null, 
          data.tipo || 'simples',
          data.diasRepeticao || null,
          cargaHorariaSemanal, 
          data.toleranciaEntrada, 
          data.toleranciaSaida
        ]
      );

      const jornada = jornadaResult.rows[0];

      // Inserir horários
      for (const h of data.horarios) {
        await client.query(
          `INSERT INTO people.jornada_horarios (jornada_id, dia_semana, sequencia, quantidade_dias, dias_semana, periodos, folga)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            jornada.id, 
            h.diaSemana ?? null,
            h.sequencia ?? null,
            h.quantidadeDias || 1,
            JSON.stringify(h.diasSemana || []),
            JSON.stringify(h.periodos || []),
            h.folga || false
          ]
        );
      }

      await client.query('COMMIT');

      await invalidateJornadaCache();
      await embedTableRowAfterInsert('jornadas', jornada.id);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'jornadas',
        descricao: `Jornada criada: ${jornada.nome} (${jornada.tipo})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: jornada.id, nome: data.nome, tipo: data.tipo },
      });

      return createdResponse({
        id: jornada.id,
        nome: jornada.nome,
        tipo: jornada.tipo,
        mensagem: 'Jornada criada com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar jornada:', error);
      return serverErrorResponse('Erro ao criar jornada');
    } finally {
      client.release();
    }
  });
}
