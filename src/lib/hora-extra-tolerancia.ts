import { query, getClient } from '@/lib/db';
import { registrarAuditoria } from '@/lib/audit';
import { invalidateSolicitacaoCache, invalidateToleranciaHoraExtraCache } from '@/lib/cache';

// =====================================================
// MÓDULO DE TOLERÂNCIA DE HORA EXTRA
// Lógica compartilhada entre registrar-entrada, registrar-saida e verificar-face
// =====================================================

export interface ToleranciaResult {
  consumiuTolerancia: boolean;
  solicitacaoId?: number;
  minutosHoraExtra: number;
  mensagem: string;
}

/**
 * Converte minutos totais para formato HH:MM
 */
function minutosParaHHMM(minutos: number): string {
  const h = Math.floor(Math.abs(minutos) / 60).toString().padStart(2, '0');
  const m = (Math.abs(minutos) % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Verifica se o colaborador está em hora extra por entrada antecipada
 * e aplica a lógica de tolerância.
 *
 * Deve ser chamada após registrar uma marcação de tipo 'entrada'.
 *
 * Retorna null se:
 * - O colaborador não tem jornada
 * - Não há horário previsto para hoje
 * - Não chegou antes do horário (com tolerância)
 * - Não há parâmetro de tolerância ativo
 */
export async function verificarEAplicarToleranciaHoraExtraEntrada(
  colaboradorId: number,
  colaboradorNome: string,
  userId: number,
  ip?: string,
  userAgent?: string
): Promise<ToleranciaResult | null> {
  try {
    const agora = new Date();

    const colabResult = await query(
      `SELECT c.jornada_id, j.tolerancia_entrada
       FROM people.colaboradores c
       LEFT JOIN people.jornadas j ON c.jornada_id = j.id
       WHERE c.id = $1 AND c.status = 'ativo'`,
      [colaboradorId]
    );

    if (colabResult.rows.length === 0 || !colabResult.rows[0].jornada_id) {
      return null;
    }

    const { jornada_id, tolerancia_entrada } = colabResult.rows[0];
    const toleranciaEntrada = tolerancia_entrada || 10;

    const diaSemana = agora.getDay();
    const horarioResult = await query(
      `SELECT periodos, folga FROM people.jornada_horarios
       WHERE jornada_id = $1 AND (
         dia_semana = $2 
         OR (dia_semana IS NULL AND dias_semana @> $3::jsonb)
       )`,
      [jornada_id, diaSemana, JSON.stringify([diaSemana])]
    );

    if (horarioResult.rows.length === 0 || horarioResult.rows[0].folga) {
      return null;
    }

    const periodos = typeof horarioResult.rows[0].periodos === 'string'
      ? JSON.parse(horarioResult.rows[0].periodos)
      : horarioResult.rows[0].periodos || [];

    if (!periodos.length) {
      return null;
    }

    const primeiroPeriodo = periodos[0];
    if (!primeiroPeriodo?.entrada) {
      return null;
    }

    const [hPrev, mPrev] = primeiroPeriodo.entrada.split(':').map(Number);
    const minutosPrevisto = hPrev * 60 + mPrev;

    const horaAtual = agora.toTimeString().substring(0, 5);
    const [hAtual, mAtual] = horaAtual.split(':').map(Number);
    const minutosAtual = hAtual * 60 + mAtual;

    const minutosAntecipados = minutosPrevisto - minutosAtual;
    if (minutosAntecipados <= toleranciaEntrada) {
      return null;
    }

    const minutosHoraExtra = minutosAntecipados;

    const parametroResult = await query(
      `SELECT id, minutos_tolerancia, dias_permitidos_por_mes
       FROM people.parametros_hora_extra
       WHERE ativo = TRUE
       ORDER BY id DESC
       LIMIT 1`
    );

    if (parametroResult.rows.length === 0) {
      return null;
    }

    const parametro = parametroResult.rows[0];
    const hoje = agora.toISOString().split('T')[0];
    const mesAtual = hoje.substring(0, 7);
    const primeiroDiaMes = `${mesAtual}-01`;
    const [anoNum, mesNum] = mesAtual.split('-').map(Number);
    const ultimoDiaMes = new Date(anoNum, mesNum, 0).toISOString().split('T')[0];

    const utilizadosResult = await query(
      `SELECT COUNT(*) AS total
       FROM people.historico_tolerancia_hora_extra
       WHERE colaborador_id = $1
         AND data BETWEEN $2::date AND $3::date
         AND consumiu_tolerancia = TRUE`,
      [colaboradorId, primeiroDiaMes, ultimoDiaMes]
    );

    const diasUtilizados = parseInt(utilizadosResult.rows[0].total);
    const diasRestantes = Math.max(0, parametro.dias_permitidos_por_mes - diasUtilizados);

    const horaInicio = minutosParaHHMM(minutosAtual);
    const horaFim = minutosParaHHMM(minutosPrevisto);
    const totalHoras = parseFloat((minutosHoraExtra / 60).toFixed(2));

    if (minutosHoraExtra <= parametro.minutos_tolerancia && diasRestantes > 0) {
      const jaConsumiu = await query(
        `SELECT id FROM people.historico_tolerancia_hora_extra
         WHERE colaborador_id = $1 AND data = $2::date`,
        [colaboradorId, hoje]
      );

      if (jaConsumiu.rows.length === 0) {
        await query(
          `INSERT INTO people.historico_tolerancia_hora_extra
             (colaborador_id, data, minutos_hora_extra, consumiu_tolerancia, parametro_id)
           VALUES ($1, $2::date, $3, TRUE, $4)`,
          [colaboradorId, hoje, minutosHoraExtra, parametro.id]
        );
      }

      await invalidateToleranciaHoraExtraCache(colaboradorId);

      await registrarAuditoria({
        usuarioId: userId,
        acao: 'CREATE',
        modulo: 'horas_extras',
        descricao: `Tolerância de hora extra (entrada antecipada) consumida: ${colaboradorNome} (${minutosHoraExtra}min, ${diasRestantes - 1} dias restantes)`,
        ip: ip || 'unknown',
        userAgent: userAgent || 'unknown',
        dadosNovos: {
          colaboradorId,
          minutosHoraExtra,
          diasRestantes: diasRestantes - 1,
          tipo: 'tolerancia_consumida_entrada',
        },
      });

      return {
        consumiuTolerancia: true,
        minutosHoraExtra,
        mensagem: 'Entrada antecipada dentro da tolerância permitida. Dia de tolerância consumido.',
      };
    } else {
      // Verificar se já existe qualquer solicitação de HE (manual ou automática) para este colaborador/data
      // Evita duplicação: ex. entrada antecipada já criou automática, saída tardia não deve criar outra
      const existente = await query(
        `SELECT id, origem FROM solicitacoes
         WHERE colaborador_id = $1
           AND tipo = 'hora_extra'
           AND data_evento = $2::date
           AND status IN ('pendente', 'aprovada')`,
        [colaboradorId, hoje]
      );

      if (existente.rows.length > 0) {
        const ehManual = existente.rows[0].origem === 'manual';
        return {
          consumiuTolerancia: false,
          minutosHoraExtra,
          mensagem: ehManual
            ? 'Solicitação manual de hora extra já existe para este dia. Automática não foi criada.'
            : 'Já existe uma solicitação de hora extra para este dia. Nova automática não foi criada.',
        };
      }

      const client = await getClient();

      try {
        await client.query('BEGIN');

        const motivo = `Entrada antecipada excedeu tolerância permitida (${minutosHoraExtra}min > ${parametro.minutos_tolerancia}min)`;
        const descricao = `Hora extra automática (entrada antecipada): ${horaInicio} às ${horaFim} (${totalHoras}h) — ${motivo}`;

        const solicitacaoResult = await client.query(
          `INSERT INTO solicitacoes (
            colaborador_id, tipo, data_evento, descricao, justificativa, origem, dados_adicionais
          ) VALUES ($1, 'hora_extra', $2::date, $3, $4, 'automatica', $5)
          RETURNING id, status, data_solicitacao`,
          [
            colaboradorId,
            hoje,
            descricao,
            'Gerada automaticamente pelo sistema (entrada antecipada)',
            JSON.stringify({
              data: hoje,
              horaInicio,
              horaFim,
              totalHoras,
              motivo,
              observacao: null,
              origem: 'automatica',
              tipoHoraExtra: 'entrada_antecipada',
            }),
          ]
        );

        const solicitacao = solicitacaoResult.rows[0];

        await client.query(
          `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
           VALUES ($1, 'pendente', $2, 'Solicitação de hora extra (entrada antecipada) gerada automaticamente pelo sistema')`,
          [solicitacao.id, userId]
        );

        const jaRegistrou = await client.query(
          `SELECT id FROM historico_tolerancia_hora_extra
           WHERE colaborador_id = $1 AND data = $2::date`,
          [colaboradorId, hoje]
        );

        if (jaRegistrou.rows.length === 0) {
          await client.query(
            `INSERT INTO historico_tolerancia_hora_extra
               (colaborador_id, data, minutos_hora_extra, consumiu_tolerancia, parametro_id)
             VALUES ($1, $2::date, $3, FALSE, $4)`,
            [colaboradorId, hoje, minutosHoraExtra, parametro.id]
          );
        }

        await client.query('COMMIT');

        await invalidateSolicitacaoCache(undefined, colaboradorId);
        await invalidateToleranciaHoraExtraCache(colaboradorId);

        await registrarAuditoria({
          usuarioId: userId,
          acao: 'CREATE',
          modulo: 'horas_extras',
          descricao: `Solicitação de hora extra automática (entrada antecipada) gerada: ${colaboradorNome} (${totalHoras}h em ${hoje})`,
          ip: ip || 'unknown',
          userAgent: userAgent || 'unknown',
          dadosNovos: {
            solicitacaoId: solicitacao.id,
            colaboradorId,
            minutosHoraExtra,
            tipo: 'solicitacao_automatica_entrada',
            horaInicio,
            horaFim,
            totalHoras,
          },
        });

        return {
          consumiuTolerancia: false,
          solicitacaoId: solicitacao.id,
          minutosHoraExtra,
          mensagem: 'Entrada antecipada excedeu a tolerância. Solicitação automática gerada para aprovação do gestor.',
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error('Erro ao processar tolerância de hora extra (entrada antecipada):', error);
    return null;
  }
}

/**
 * Verifica se o colaborador está em hora extra por saída tardia
 * e aplica a lógica de tolerância.
 *
 * Deve ser chamada após registrar uma marcação de tipo 'saida'.
 *
 * Retorna null se:
 * - O colaborador não tem jornada
 * - Não há horário previsto para hoje
 * - Não está em hora extra
 * - Não há parâmetro de tolerância ativo
 */
export async function verificarEAplicarToleranciaHoraExtra(
  colaboradorId: number,
  colaboradorNome: string,
  userId: number,
  ip?: string,
  userAgent?: string
): Promise<ToleranciaResult | null> {
  try {
    const agora = new Date();

    // 1. Buscar jornada do colaborador
    const colabResult = await query(
      `SELECT c.jornada_id, j.tolerancia_saida
       FROM people.colaboradores c
       LEFT JOIN people.jornadas j ON c.jornada_id = j.id
       WHERE c.id = $1 AND c.status = 'ativo'`,
      [colaboradorId]
    );

    if (colabResult.rows.length === 0 || !colabResult.rows[0].jornada_id) {
      return null;
    }

    const { jornada_id, tolerancia_saida } = colabResult.rows[0];
    const toleranciaSaida = tolerancia_saida || 10;

    // 2. Buscar horário previsto de saída para hoje
    const diaSemana = agora.getDay();
    const horarioResult = await query(
      `SELECT periodos, folga FROM people.jornada_horarios
       WHERE jornada_id = $1 AND (
         dia_semana = $2 
         OR (dia_semana IS NULL AND dias_semana @> $3::jsonb)
       )`,
      [jornada_id, diaSemana, JSON.stringify([diaSemana])]
    );

    if (horarioResult.rows.length === 0 || horarioResult.rows[0].folga) {
      return null;
    }

    // Extrair o último horário de saída dos períodos
    const periodos = typeof horarioResult.rows[0].periodos === 'string'
      ? JSON.parse(horarioResult.rows[0].periodos)
      : horarioResult.rows[0].periodos || [];

    if (!periodos.length) {
      return null;
    }

    const ultimoPeriodo = periodos[periodos.length - 1];
    if (!ultimoPeriodo?.saida) {
      return null;
    }

    const [hPrev, mPrev] = ultimoPeriodo.saida.split(':').map(Number);
    const minutosPrevisto = hPrev * 60 + mPrev;

    const horaAtual = agora.toTimeString().substring(0, 5);
    const [hAtual, mAtual] = horaAtual.split(':').map(Number);
    const minutosAtual = hAtual * 60 + mAtual;

    // 3. Verificar se está em hora extra (além da tolerância da jornada)
    const diferenca = minutosPrevisto - minutosAtual;
    if (diferenca >= -toleranciaSaida) {
      // Não está em hora extra (dentro da tolerância da jornada)
      return null;
    }

    const minutosHoraExtra = minutosAtual - minutosPrevisto;
    if (minutosHoraExtra <= 0) {
      return null;
    }

    // 4. Buscar parâmetros de tolerância de hora extra
    const parametroResult = await query(
      `SELECT id, minutos_tolerancia, dias_permitidos_por_mes
       FROM people.parametros_hora_extra
       WHERE ativo = TRUE
       ORDER BY id DESC
       LIMIT 1`
    );

    if (parametroResult.rows.length === 0) {
      return null;
    }

    const parametro = parametroResult.rows[0];
    const hoje = agora.toISOString().split('T')[0];
    const mesAtual = hoje.substring(0, 7);
    const primeiroDiaMes = `${mesAtual}-01`;
    const [anoNum, mesNum] = mesAtual.split('-').map(Number);
    const ultimoDiaMes = new Date(anoNum, mesNum, 0).toISOString().split('T')[0];

    // 5. Contar dias de tolerância já utilizados no mês
    const utilizadosResult = await query(
      `SELECT COUNT(*) AS total
       FROM people.historico_tolerancia_hora_extra
       WHERE colaborador_id = $1
         AND data BETWEEN $2::date AND $3::date
         AND consumiu_tolerancia = TRUE`,
      [colaboradorId, primeiroDiaMes, ultimoDiaMes]
    );

    const diasUtilizados = parseInt(utilizadosResult.rows[0].total);
    const diasRestantes = Math.max(0, parametro.dias_permitidos_por_mes - diasUtilizados);

    const horaInicio = minutosParaHHMM(minutosPrevisto);
    const horaFim = minutosParaHHMM(minutosAtual);
    const totalHoras = parseFloat((minutosHoraExtra / 60).toFixed(2));

    // 6. Decisão: consumir tolerância ou gerar solicitação
    if (minutosHoraExtra <= parametro.minutos_tolerancia && diasRestantes > 0) {
      // ---- CONSUMIR TOLERÂNCIA ----
      const jaConsumiu = await query(
        `SELECT id FROM people.historico_tolerancia_hora_extra
         WHERE colaborador_id = $1 AND data = $2::date`,
        [colaboradorId, hoje]
      );

      if (jaConsumiu.rows.length === 0) {
        await query(
          `INSERT INTO people.historico_tolerancia_hora_extra
             (colaborador_id, data, minutos_hora_extra, consumiu_tolerancia, parametro_id)
           VALUES ($1, $2::date, $3, TRUE, $4)`,
          [colaboradorId, hoje, minutosHoraExtra, parametro.id]
        );
      }

      await invalidateToleranciaHoraExtraCache(colaboradorId);

      await registrarAuditoria({
        usuarioId: userId,
        acao: 'CREATE',
        modulo: 'horas_extras',
        descricao: `Tolerância de hora extra consumida: ${colaboradorNome} (${minutosHoraExtra}min, ${diasRestantes - 1} dias restantes)`,
        ip: ip || 'unknown',
        userAgent: userAgent || 'unknown',
        dadosNovos: {
          colaboradorId,
          minutosHoraExtra,
          diasRestantes: diasRestantes - 1,
          tipo: 'tolerancia_consumida',
        },
      });

      return {
        consumiuTolerancia: true,
        minutosHoraExtra,
        mensagem: 'Hora extra dentro da tolerância permitida. Dia de tolerância consumido.',
      };
    } else {
      // ---- GERAR SOLICITAÇÃO AUTOMÁTICA ----
      // Verificar se já existe qualquer solicitação de HE (manual ou automática) para este colaborador/data
      // Evita duplicação: ex. entrada antecipada já criou automática, saída tardia não deve criar outra
      const existente = await query(
        `SELECT id, origem FROM solicitacoes
         WHERE colaborador_id = $1
           AND tipo = 'hora_extra'
           AND data_evento = $2::date
           AND status IN ('pendente', 'aprovada')`,
        [colaboradorId, hoje]
      );

      if (existente.rows.length > 0) {
        const ehManual = existente.rows[0].origem === 'manual';
        return {
          consumiuTolerancia: false,
          minutosHoraExtra,
          mensagem: ehManual
            ? 'Solicitação manual de hora extra já existe para este dia. Automática não foi criada.'
            : 'Já existe uma solicitação de hora extra para este dia. Nova automática não foi criada.',
        };
      }

      const client = await getClient();

      try {
        await client.query('BEGIN');

        const motivo = `Hora extra excedeu tolerância permitida (${minutosHoraExtra}min > ${parametro.minutos_tolerancia}min)`;
        const descricao = `Hora extra automática: ${horaInicio} às ${horaFim} (${totalHoras}h) — ${motivo}`;

        const solicitacaoResult = await client.query(
          `INSERT INTO solicitacoes (
            colaborador_id, tipo, data_evento, descricao, justificativa, origem, dados_adicionais
          ) VALUES ($1, 'hora_extra', $2::date, $3, $4, 'automatica', $5)
          RETURNING id, status, data_solicitacao`,
          [
            colaboradorId,
            hoje,
            descricao,
            'Gerada automaticamente pelo sistema',
            JSON.stringify({
              data: hoje,
              horaInicio,
              horaFim,
              totalHoras,
              motivo,
              observacao: null,
              origem: 'automatica',
            }),
          ]
        );

        const solicitacao = solicitacaoResult.rows[0];

        await client.query(
          `INSERT INTO solicitacoes_historico (solicitacao_id, status_novo, usuario_id, observacao)
           VALUES ($1, 'pendente', $2, 'Solicitação de hora extra gerada automaticamente pelo sistema')`,
          [solicitacao.id, userId]
        );

        // Registrar no histórico de tolerância (como não consumida)
        const jaRegistrou = await client.query(
          `SELECT id FROM historico_tolerancia_hora_extra
           WHERE colaborador_id = $1 AND data = $2::date`,
          [colaboradorId, hoje]
        );

        if (jaRegistrou.rows.length === 0) {
          await client.query(
            `INSERT INTO historico_tolerancia_hora_extra
               (colaborador_id, data, minutos_hora_extra, consumiu_tolerancia, parametro_id)
             VALUES ($1, $2::date, $3, FALSE, $4)`,
            [colaboradorId, hoje, minutosHoraExtra, parametro.id]
          );
        }

        await client.query('COMMIT');

        await invalidateSolicitacaoCache(undefined, colaboradorId);
        await invalidateToleranciaHoraExtraCache(colaboradorId);

        await registrarAuditoria({
          usuarioId: userId,
          acao: 'CREATE',
          modulo: 'horas_extras',
          descricao: `Solicitação de hora extra automática gerada: ${colaboradorNome} (${totalHoras}h em ${hoje})`,
          ip: ip || 'unknown',
          userAgent: userAgent || 'unknown',
          dadosNovos: {
            solicitacaoId: solicitacao.id,
            colaboradorId,
            minutosHoraExtra,
            tipo: 'solicitacao_automatica',
            horaInicio,
            horaFim,
            totalHoras,
          },
        });

        return {
          consumiuTolerancia: false,
          solicitacaoId: solicitacao.id,
          minutosHoraExtra,
          mensagem: 'Hora extra excedeu a tolerância. Solicitação automática gerada para aprovação do gestor.',
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error('Erro ao processar tolerância de hora extra:', error);
    return null;
  }
}
