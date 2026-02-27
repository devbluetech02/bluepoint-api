import { query } from '@/lib/db';

export interface CustoHoraExtra {
  horas_extras: number;
  valor_he_base: number;
  valor_dsr: number;
  valor_13: number;
  valor_ferias: number;
  um_terco_ferias: number;
  valor_fgts: number;
  valor_inss: number;
  custo_dia: number;
  custo_mes: number;
  custo_ano: number;
}

export interface DadosColaboradorCusto {
  cargo: string;
  cargo_id: number;
  empresa: string;
  empresa_id: number;
  valor_hora_extra_75: number;
}

/**
 * Busca dados necessários do colaborador para cálculo de custos:
 * cargo, empresa e valor da hora extra 75%.
 */
export async function buscarDadosColaboradorParaCusto(
  colaboradorId: number
): Promise<DadosColaboradorCusto | null> {
  const result = await query(
    `SELECT
       cg.nome AS cargo,
       cg.id AS cargo_id,
       cg.valor_hora_extra_75,
       cg.salario_medio,
       e.nome_fantasia AS empresa,
       e.id AS empresa_id
     FROM bluepoint.bt_colaboradores c
     LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
     LEFT JOIN bluepoint.bt_empresas e ON c.empresa_id = e.id
     WHERE c.id = $1`,
    [colaboradorId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  let valorHe75: number | null = null;

  if (row.valor_hora_extra_75) {
    valorHe75 = parseFloat(row.valor_hora_extra_75);
  } else if (row.salario_medio) {
    // CLT: 220h mensais, adicional de 75%
    const salario = parseFloat(row.salario_medio);
    valorHe75 = parseFloat(((salario / 220) * 1.75).toFixed(2));
  }

  if (!valorHe75) return null;

  return {
    cargo: row.cargo || 'N/A',
    cargo_id: row.cargo_id,
    empresa: row.empresa || 'N/A',
    empresa_id: row.empresa_id,
    valor_hora_extra_75: valorHe75,
  };
}

/**
 * Calcula horas decimais a partir de dois horários HH:MM.
 * Se horarioFim < horarioInicio, assume que passou da meia-noite.
 */
export function calcularHorasDecimais(horarioInicio: string, horarioFim: string): number {
  const [hIni, mIni] = horarioInicio.split(':').map(Number);
  const [hFim, mFim] = horarioFim.split(':').map(Number);

  let minutosInicio = hIni * 60 + mIni;
  let minutosFim = hFim * 60 + mFim;

  if (minutosFim < minutosInicio) {
    minutosFim += 24 * 60;
  }

  const diferenca = minutosFim - minutosInicio;
  const horasInteiras = Math.floor(diferenca / 60);
  const minutosRestantes = diferenca % 60;

  return horasInteiras + minutosRestantes / 60;
}

/**
 * Calcula todos os componentes de custo de hora extra conforme legislação trabalhista brasileira.
 *
 * Fórmula:
 *   valor_he_base   = horasDecimal × valor_hora_extra_75
 *   dsr             = valor_he_base / 6
 *   13º             = (valor_he_base + dsr) / 12
 *   férias           = (valor_he_base + dsr) / 12
 *   1/3 férias       = férias / 3
 *   base_encargos   = valor_he_base + dsr + 13º + férias + 1/3_férias
 *   fgts            = base_encargos × 0.08
 *   inss            = base_encargos × 0.375
 *   custo_dia       = base_encargos + fgts + inss
 *   custo_mes       = custo_dia × 22
 *   custo_ano       = custo_mes × 12
 */
export function calcularComponentesCusto(
  horasDecimais: number,
  valorHoraExtra75: number
): CustoHoraExtra {
  const valor_he_base = horasDecimais * valorHoraExtra75;
  const valor_dsr = valor_he_base / 6;
  const valor_13 = (valor_he_base + valor_dsr) / 12;
  const valor_ferias = (valor_he_base + valor_dsr) / 12;
  const um_terco_ferias = valor_ferias / 3;

  const base_encargos = valor_he_base + valor_dsr + valor_13 + valor_ferias + um_terco_ferias;

  const valor_fgts = base_encargos * 0.08;
  const valor_inss = base_encargos * 0.375;

  const custo_dia = base_encargos + valor_fgts + valor_inss;
  const custo_mes = custo_dia * 22;
  const custo_ano = custo_mes * 12;

  const r = (n: number) => parseFloat(n.toFixed(2));

  return {
    horas_extras: parseFloat(horasDecimais.toFixed(4)),
    valor_he_base: r(valor_he_base),
    valor_dsr: r(valor_dsr),
    valor_13: r(valor_13),
    valor_ferias: r(valor_ferias),
    um_terco_ferias: r(um_terco_ferias),
    valor_fgts: r(valor_fgts),
    valor_inss: r(valor_inss),
    custo_dia: r(custo_dia),
    custo_mes: r(custo_mes),
    custo_ano: r(custo_ano),
  };
}

/**
 * Pipeline completo: busca dados do colaborador, calcula horas e custos.
 * Retorna null se o colaborador não tem cargo com valor_hora_extra_75 configurado.
 */
export async function calcularCustoHoraExtra(
  colaboradorId: number,
  horarioInicio: string,
  horarioFim: string
): Promise<(CustoHoraExtra & DadosColaboradorCusto) | null> {
  const dados = await buscarDadosColaboradorParaCusto(colaboradorId);
  if (!dados) return null;

  const horasDecimais = calcularHorasDecimais(horarioInicio, horarioFim);
  if (horasDecimais <= 0) return null;

  const custos = calcularComponentesCusto(horasDecimais, dados.valor_hora_extra_75);

  return { ...custos, ...dados };
}

export interface SaldoGestor {
  gestor_id: number;
  gestor_nome: string;
  limite_mensal: number;
  pode_extrapolar: boolean;
  acumulado_mes: number;
  saldo_disponivel: number;
  total_aprovacoes_mes: number;
}

/**
 * Soma o custo de todas as HE aprovadas pelo gestor no mês/ano corrente.
 * Usa o campo dados_adicionais->>'custo_aprovado' gravado no momento da aprovação.
 */
export async function calcularAcumuladoMesGestor(gestorId: number): Promise<{ total: number; qtd: number }> {
  const result = await query(
    `SELECT
       COALESCE(SUM((dados_adicionais->>'custo_aprovado')::numeric), 0) AS total,
       COUNT(*)::int AS qtd
     FROM bluepoint.bt_solicitacoes
     WHERE tipo = 'hora_extra'
       AND status = 'aprovada'
       AND aprovador_id = $1
       AND EXTRACT(MONTH FROM data_aprovacao) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(YEAR FROM data_aprovacao) = EXTRACT(YEAR FROM CURRENT_DATE)`,
    [gestorId]
  );

  return {
    total: parseFloat(parseFloat(result.rows[0].total).toFixed(2)),
    qtd: result.rows[0].qtd,
  };
}

/**
 * Retorna o saldo atual do gestor (limite - acumulado no mês).
 * Retorna null se o gestor não tem limite configurado.
 */
export async function obterSaldoGestor(gestorId: number): Promise<SaldoGestor | null> {
  const limiteResult = await query(
    `SELECT l.limite_mensal, l.pode_extrapolar, c.nome AS gestor_nome
     FROM bluepoint.bt_limites_he_gestores l
     JOIN bluepoint.bt_colaboradores c ON l.gestor_id = c.id
     WHERE l.gestor_id = $1`,
    [gestorId]
  );

  if (limiteResult.rows.length === 0) return null;

  const { limite_mensal, pode_extrapolar, gestor_nome } = limiteResult.rows[0];
  const limiteMensal = parseFloat(limite_mensal);

  const { total: acumuladoMes, qtd } = await calcularAcumuladoMesGestor(gestorId);

  return {
    gestor_id: gestorId,
    gestor_nome,
    limite_mensal: limiteMensal,
    pode_extrapolar,
    acumulado_mes: acumuladoMes,
    saldo_disponivel: parseFloat(Math.max(0, limiteMensal - acumuladoMes).toFixed(2)),
    total_aprovacoes_mes: qtd,
  };
}

export interface VerificacaoLimiteGestor {
  excedido: boolean;
  bloqueado: boolean;
  gestor_id: number;
  gestor_nome: string;
  custo_novo: number;
  acumulado_mes: number;
  total_com_novo: number;
  limite_mensal: number;
  pode_extrapolar: boolean;
  saldo_disponivel: number;
}

/**
 * Verifica se o gestor ainda tem saldo para aprovar uma nova hora extra.
 *
 * Soma o custo_aprovado de todas as HE aprovadas por ele no mês corrente
 * e compara com o limite_mensal configurado pelo Admin/DP.
 *
 * - Se pode_extrapolar = true  → retorna excedido=true mas bloqueado=false (apenas aviso)
 * - Se pode_extrapolar = false → retorna excedido=true e bloqueado=true (bloqueia aprovação)
 *
 * Retorna null se não há limite configurado para o gestor.
 */
export async function verificarLimiteMensalGestor(
  gestorId: number,
  colaboradorId: number,
  horarioInicio: string,
  horarioFim: string
): Promise<VerificacaoLimiteGestor | null> {
  const limiteResult = await query(
    `SELECT l.limite_mensal, l.pode_extrapolar, c.nome AS gestor_nome
     FROM bluepoint.bt_limites_he_gestores l
     JOIN bluepoint.bt_colaboradores c ON l.gestor_id = c.id
     WHERE l.gestor_id = $1`,
    [gestorId]
  );

  if (limiteResult.rows.length === 0) return null;

  const { limite_mensal, pode_extrapolar, gestor_nome } = limiteResult.rows[0];
  const limiteMensal = parseFloat(limite_mensal);

  const dadosColab = await query(
    `SELECT cg.valor_hora_extra_75, cg.salario_medio
     FROM bluepoint.bt_colaboradores c
     JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
     WHERE c.id = $1`,
    [colaboradorId]
  );

  if (dadosColab.rows.length === 0) {
    return null;
  }

  const row = dadosColab.rows[0];
  let valorHe75: number | null = null;

  if (row.valor_hora_extra_75) {
    valorHe75 = parseFloat(row.valor_hora_extra_75);
  } else if (row.salario_medio) {
    const salario = parseFloat(row.salario_medio);
    valorHe75 = parseFloat(((salario / 220) * 1.75).toFixed(2));
  }

  if (!valorHe75) {
    return null;
  }

  const horasDecimais = calcularHorasDecimais(horarioInicio, horarioFim);
  if (horasDecimais <= 0) return null;

  const custoNovo = calcularComponentesCusto(horasDecimais, valorHe75);

  const { total: acumuladoMes } = await calcularAcumuladoMesGestor(gestorId);
  const totalComNovo = acumuladoMes + custoNovo.custo_dia;
  const excedido = totalComNovo > limiteMensal;

  return {
    excedido,
    bloqueado: excedido && !pode_extrapolar,
    gestor_id: gestorId,
    gestor_nome,
    custo_novo: custoNovo.custo_dia,
    acumulado_mes: acumuladoMes,
    total_com_novo: parseFloat(totalComNovo.toFixed(2)),
    limite_mensal: limiteMensal,
    pode_extrapolar,
    saldo_disponivel: parseFloat(Math.max(0, limiteMensal - acumuladoMes).toFixed(2)),
  };
}

/**
 * Persiste o cálculo detalhado de custos no banco de dados.
 */
export async function salvarCustoHoraExtra(
  solicitacaoId: number,
  colaboradorId: number,
  cargoId: number,
  empresaId: number,
  custos: CustoHoraExtra,
  solicitacaoOriginalId?: number
): Promise<void> {
  await query(
    `INSERT INTO bluepoint.bt_custo_horas_extras (
       solicitacao_id, solicitacao_original_id, colaborador_id, cargo_id, empresa_id,
       horas_extras, valor_he_base, valor_dsr, valor_13, valor_ferias,
       um_terco_ferias, valor_fgts, valor_inss, custo_dia, custo_mes, custo_ano
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      solicitacaoId,
      solicitacaoOriginalId ?? null,
      colaboradorId,
      cargoId,
      empresaId,
      custos.horas_extras,
      custos.valor_he_base,
      custos.valor_dsr,
      custos.valor_13,
      custos.valor_ferias,
      custos.um_terco_ferias,
      custos.valor_fgts,
      custos.valor_inss,
      custos.custo_dia,
      custos.custo_mes,
      custos.custo_ano,
    ]
  );
}
