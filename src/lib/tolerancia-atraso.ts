import { query, getClient, PoolClient } from '@/lib/db';

// =====================================================
// MÓDULO DE TOLERÂNCIA DE ATRASO
// Lógica de negócio para registro de ponto com controle
// de tolerância por período e por dia.
// =====================================================

export interface ParametrosTolerancia {
  toleranciaPeriodoMin: number;
  toleranciaDiarioMaxMin: number;
  ativo: boolean;
}

export interface JornadaDoDia {
  jornadaId: number;
  periodos: Array<{ entrada: string; saida: string }>;
  folga: boolean;
}

export interface PeriodoAtivo {
  tipo: 'entrada' | 'retorno';
  horarioPrevisto: string; // HH:mm
  periodoIndex: number;
}

export interface AnaliseAtraso {
  atrasado: boolean;
  atrasoMinutos: number;
  horarioPrevisto: string;
  horarioTentativa: string;
  tipoMarcacao: 'entrada' | 'saida' | 'almoco' | 'retorno';
  periodoIndex: number;
  dentroToleranciaPeriodo: boolean;
  dentroToleranciaDiaria: boolean;
  toleranciaPeriodoMin: number;
  toleranciaDiariaMaxMin: number;
  toleranciaDiariaJaUsada: number;
  toleranciaDiariaRestante: number;
  registrarNormalmente: boolean;
}

/**
 * Converte string "HH:mm" em minutos desde meia-noite.
 */
function horaParaMinutos(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Busca os parâmetros GLOBAIS de tolerância de atraso (parametros_tolerancia_atraso).
 * Configurados pelo RH/DP, independentes de jornada.
 */
export async function obterParametrosTolerancia(): Promise<ParametrosTolerancia> {
  const result = await query(
    `SELECT tolerancia_periodo_min, tolerancia_diario_max_min, ativo
     FROM people.parametros_tolerancia_atraso
     ORDER BY id DESC
     LIMIT 1`
  );

  if (result.rows.length === 0) {
    return { toleranciaPeriodoMin: 10, toleranciaDiarioMaxMin: 10, ativo: true };
  }

  const row = result.rows[0];
  return {
    toleranciaPeriodoMin: row.tolerancia_periodo_min ?? 10,
    toleranciaDiarioMaxMin: row.tolerancia_diario_max_min ?? 10,
    ativo: row.ativo ?? true,
  };
}

/**
 * Busca a jornada e os horários previstos do colaborador para o dia atual.
 */
export async function obterJornadaDoDia(
  colaboradorId: number,
  data?: Date
): Promise<JornadaDoDia | null> {
  const agora = data || new Date();
  const diaSemana = agora.getDay();

  const result = await query(
    `SELECT c.jornada_id,
            jh.periodos,
            jh.folga
     FROM people.colaboradores c
     JOIN people.jornadas j ON c.jornada_id = j.id
     LEFT JOIN people.jornada_horarios jh
       ON jh.jornada_id = j.id
       AND jh.folga = false
       AND (jh.dia_semana = $2 OR jh.dias_semana @> $3::jsonb)
     WHERE c.id = $1 AND c.status = 'ativo' AND j.status = 'ativo'
     LIMIT 1`,
    [colaboradorId, diaSemana, JSON.stringify([diaSemana])]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  if (!row.jornada_id) return null;

  const periodos = typeof row.periodos === 'string'
    ? JSON.parse(row.periodos)
    : row.periodos || [];

  return {
    jornadaId: row.jornada_id,
    periodos,
    folga: row.folga ?? false,
  };
}

/**
 * Busca as marcações do colaborador no dia atual e determina
 * qual é o próximo tipo de marcação esperado e o horário previsto.
 */
export async function determinarProximoEvento(
  colaboradorId: number,
  jornada: JornadaDoDia
): Promise<{
  tipoMarcacao: 'entrada' | 'saida' | 'almoco' | 'retorno';
  horarioPrevisto: string | null;
  periodoIndex: number;
  marcacoesHoje: Array<{ id: number; tipo: string; data_hora: string }>;
}> {
  const marcacoesResult = await query<{ id: number; tipo: string; data_hora: string }>(
    `SELECT id, tipo, data_hora FROM people.marcacoes
     WHERE colaborador_id = $1
       AND DATE(data_hora) = CURRENT_DATE
     ORDER BY data_hora ASC`,
    [colaboradorId]
  );

  const marcacoes = marcacoesResult.rows;
  const periodos = jornada.periodos;
  const numPeriodos = periodos.length;

  if (marcacoes.length === 0) {
    return {
      tipoMarcacao: 'entrada',
      horarioPrevisto: periodos[0]?.entrada || null,
      periodoIndex: 0,
      marcacoesHoje: marcacoes,
    };
  }

  const ultimaMarcacao = marcacoes[marcacoes.length - 1];

  if (numPeriodos >= 2) {
    // Jornada com almoço: entrada → almoco → retorno → saida → (repete)
    // Usa o tipo da última marcação para inferir o próximo — robusto contra contagens erradas.
    type ProximoEvento = { tipo: 'entrada' | 'almoco' | 'retorno' | 'saida'; horario: string | null; periodoIndex: number };
    const proxima: Record<string, ProximoEvento> = {
      entrada: { tipo: 'almoco',  horario: periodos[0]?.saida || null,               periodoIndex: 0 },
      almoco:  { tipo: 'retorno', horario: periodos[1]?.entrada || null,              periodoIndex: 1 },
      retorno: { tipo: 'saida',   horario: periodos[numPeriodos - 1]?.saida || null,  periodoIndex: numPeriodos - 1 },
      saida:   { tipo: 'entrada', horario: periodos[0]?.entrada || null,              periodoIndex: 0 },
    };

    const next = proxima[ultimaMarcacao.tipo] ?? { tipo: 'entrada' as const, horario: periodos[0]?.entrada || null, periodoIndex: 0 };

    return { tipoMarcacao: next.tipo, horarioPrevisto: next.horario, periodoIndex: next.periodoIndex, marcacoesHoje: marcacoes };
  }

  // Jornada sem almoço: entrada → saida → entrada → saida
  if (ultimaMarcacao.tipo === 'entrada' || ultimaMarcacao.tipo === 'retorno') {
    return {
      tipoMarcacao: 'saida',
      horarioPrevisto: periodos[0]?.saida || null,
      periodoIndex: 0,
      marcacoesHoje: marcacoes,
    };
  }

  return {
    tipoMarcacao: 'entrada',
    horarioPrevisto: periodos[0]?.entrada || null,
    periodoIndex: 0,
    marcacoesHoje: marcacoes,
  };
}

/**
 * Busca o total de minutos de atraso já tolerados no dia para o colaborador.
 */
export async function obterAtrasosToleradorNoDia(
  colaboradorId: number,
  data?: Date
): Promise<number> {
  const dataRef = data || new Date();
  const dataStr = dataRef.toISOString().split('T')[0];

  const result = await query(
    `SELECT COALESCE(SUM(atraso_minutos), 0) as total
     FROM people.atrasos_tolerados
     WHERE colaborador_id = $1
       AND data = $2
       AND tolerado = true`,
    [colaboradorId, dataStr]
  );

  return parseInt(result.rows[0].total) || 0;
}

/**
 * Análise completa: calcula atraso e verifica tolerância usando parâmetros globais.
 * 
 * Retorna todas as informações necessárias para o endpoint decidir
 * se registra normalmente ou se precisa pedir aprovação ao gestor.
 */
export async function analisarAtraso(
  colaboradorId: number,
  parametros: ParametrosTolerancia,
  tipoMarcacao: 'entrada' | 'saida' | 'almoco' | 'retorno',
  horarioPrevisto: string | null,
  periodoIndex: number,
  horaAtual?: Date
): Promise<AnaliseAtraso> {
  const agora = horaAtual || new Date();
  const horaStr = agora.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Sao_Paulo',
  });

  const toleranciaPeriodo = parametros.toleranciaPeriodoMin;
  const toleranciaDiariaMax = parametros.toleranciaDiarioMaxMin;

  // Se tolerância desativada globalmente, registra sempre normalmente
  if (!parametros.ativo) {
    return {
      atrasado: false,
      atrasoMinutos: 0,
      horarioPrevisto: horarioPrevisto || '--:--',
      horarioTentativa: horaStr,
      tipoMarcacao,
      periodoIndex,
      dentroToleranciaPeriodo: true,
      dentroToleranciaDiaria: true,
      toleranciaPeriodoMin: toleranciaPeriodo,
      toleranciaDiariaMaxMin: toleranciaDiariaMax,
      toleranciaDiariaJaUsada: 0,
      toleranciaDiariaRestante: toleranciaDiariaMax,
      registrarNormalmente: true,
    };
  }

  // Sem horário previsto = sem controle de atraso
  if (!horarioPrevisto) {
    return {
      atrasado: false,
      atrasoMinutos: 0,
      horarioPrevisto: '--:--',
      horarioTentativa: horaStr,
      tipoMarcacao,
      periodoIndex,
      dentroToleranciaPeriodo: true,
      dentroToleranciaDiaria: true,
      toleranciaPeriodoMin: toleranciaPeriodo,
      toleranciaDiariaMaxMin: toleranciaDiariaMax,
      toleranciaDiariaJaUsada: 0,
      toleranciaDiariaRestante: toleranciaDiariaMax,
      registrarNormalmente: true,
    };
  }

  const minutosAtual = horaParaMinutos(horaStr);
  const minutosPrevisto = horaParaMinutos(horarioPrevisto);

  const ehEntrada = tipoMarcacao === 'entrada';

  const atrasoMinutos = ehEntrada
    ? minutosAtual - minutosPrevisto
    : 0;

  if (atrasoMinutos <= 0 || !ehEntrada) {
    return {
      atrasado: false,
      atrasoMinutos: Math.max(0, atrasoMinutos),
      horarioPrevisto,
      horarioTentativa: horaStr,
      tipoMarcacao,
      periodoIndex,
      dentroToleranciaPeriodo: true,
      dentroToleranciaDiaria: true,
      toleranciaPeriodoMin: toleranciaPeriodo,
      toleranciaDiariaMaxMin: toleranciaDiariaMax,
      toleranciaDiariaJaUsada: 0,
      toleranciaDiariaRestante: toleranciaDiariaMax,
      registrarNormalmente: true,
    };
  }

  // Atrasado: verificar tolerâncias globais
  const toleranciaDiariaJaUsada = await obterAtrasosToleradorNoDia(colaboradorId);
  const toleranciaDiariaRestante = Math.max(0, toleranciaDiariaMax - toleranciaDiariaJaUsada);

  const dentroToleranciaPeriodo = atrasoMinutos <= toleranciaPeriodo;
  const dentroToleranciaDiaria = (toleranciaDiariaJaUsada + atrasoMinutos) <= toleranciaDiariaMax;
  const registrarNormalmente = dentroToleranciaPeriodo && dentroToleranciaDiaria;

  return {
    atrasado: true,
    atrasoMinutos,
    horarioPrevisto,
    horarioTentativa: horaStr,
    tipoMarcacao,
    periodoIndex,
    dentroToleranciaPeriodo,
    dentroToleranciaDiaria,
    toleranciaPeriodoMin: toleranciaPeriodo,
    toleranciaDiariaMaxMin: toleranciaDiariaMax,
    toleranciaDiariaJaUsada,
    toleranciaDiariaRestante,
    registrarNormalmente,
  };
}

/**
 * Registra o atraso como tolerado na tabela de controle interno.
 * Deve ser chamado quando o ponto é registrado normalmente dentro da tolerância.
 */
export async function registrarAtrasoTolerado(
  colaboradorId: number,
  tipoMarcacao: 'entrada' | 'saida' | 'almoco' | 'retorno',
  horarioPrevisto: string,
  horarioReal: Date,
  atrasoMinutos: number,
  marcacaoId: number,
  clientDb?: PoolClient
): Promise<void> {
  const dataStr = horarioReal.toISOString().split('T')[0];
  const executor = clientDb || { query: (text: string, params?: unknown[]) => query(text, params) };

  await executor.query(
    `INSERT INTO people.atrasos_tolerados
       (colaborador_id, data, tipo_marcacao, horario_previsto, horario_real, atraso_minutos, tolerado, marcacao_id)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
    [colaboradorId, dataStr, tipoMarcacao, horarioPrevisto, horarioReal, atrasoMinutos, marcacaoId]
  );
}

/**
 * Busca o gestor responsável pelo colaborador.
 * Primeiro tenta o gestor do departamento; depois verifica gestores diretos.
 */
export async function obterGestorDoColaborador(
  colaboradorId: number
): Promise<{ id: number; nome: string; email: string } | null> {
  type GestorRow = { id: number; nome: string; email: string };

  // Gestor do departamento (nunca retorna o próprio colaborador como gestor de si mesmo)
  const result = await query<GestorRow>(
    `SELECT g.id, g.nome, g.email
     FROM people.colaboradores c
     JOIN people.departamentos d ON c.departamento_id = d.id
     JOIN people.colaboradores g ON d.gestor_id = g.id
     WHERE c.id = $1 AND g.status = 'ativo' AND g.id != $1
     LIMIT 1`,
    [colaboradorId]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  // Fallback: busca qualquer gestor/admin ativo, excluindo o próprio colaborador
  const fallback = await query<GestorRow>(
    `SELECT id, nome, email
     FROM people.colaboradores
     WHERE tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')
       AND status = 'ativo'
       AND id != $1
     ORDER BY tipo = 'admin' DESC, id ASC
     LIMIT 1`,
    [colaboradorId]
  );

  return fallback.rows[0] || null;
}

/**
 * Cria uma solicitação de atraso (tipo 'atraso') com status PENDENTE.
 * Retorna o ID da solicitação criada.
 */
export async function criarSolicitacaoAtraso(params: {
  colaboradorId: number;
  gestorId: number;
  horarioSolicitacao: Date;
  horarioPrevisto: string;
  atrasoMinutos: number;
  justificativa: string;
  tipoMarcacao: 'entrada' | 'saida' | 'almoco' | 'retorno';
  periodoIndex: number;
  metodo: string;
  latitude?: number;
  longitude?: number;
  fotoUrl?: string;
  empresaId?: number;
}): Promise<number> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const dataEvento = params.horarioSolicitacao.toISOString().split('T')[0];

    const dadosAdicionais = {
      horarioSolicitacao: params.horarioSolicitacao.toISOString(),
      horarioPrevisto: params.horarioPrevisto,
      atrasoMinutos: params.atrasoMinutos,
      tipoMarcacao: params.tipoMarcacao,
      periodoIndex: params.periodoIndex,
      metodo: params.metodo,
      latitude: params.latitude || null,
      longitude: params.longitude || null,
      fotoUrl: params.fotoUrl || null,
      empresaId: params.empresaId || null,
    };

    const result = await client.query(
      `INSERT INTO people.solicitacoes
         (colaborador_id, tipo, status, data_solicitacao, data_evento,
          descricao, justificativa, dados_adicionais, gestor_id, origem)
       VALUES ($1, 'atraso', 'pendente', NOW(), $2,
               $3, $4, $5, $6, 'sistema')
       RETURNING id`,
      [
        params.colaboradorId,
        dataEvento,
        `Solicitação de registro de ponto com atraso de ${params.atrasoMinutos} minutos (${params.tipoMarcacao})`,
        params.justificativa,
        JSON.stringify(dadosAdicionais),
        params.gestorId,
      ]
    );

    const solicitacaoId = result.rows[0].id;

    // Registrar histórico
    await client.query(
      `INSERT INTO people.solicitacoes_historico
         (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
       VALUES ($1, NULL, 'pendente', $2, 'Solicitação de registro de ponto com atraso criada pelo colaborador')`,
      [solicitacaoId, params.colaboradorId]
    );

    await client.query('COMMIT');
    return solicitacaoId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
