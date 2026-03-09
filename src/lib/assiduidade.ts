/**
 * Regras de negocio para calculo de assiduidade (bonus mensal configuravel).
 * Schema: bluepoint — tabelas bt_historico_assiduidade, bt_parametros_assiduidade.
 *
 * Os pontos de ocorrencia (gravidade) vem de uma API externa.
 * Os parametros (limites, valores, cargos excluidos) vem de bt_parametros_assiduidade.
 *
 * Cadeia cronologica: cada mes depende do valor do mes anterior.
 * Quando ha meses faltantes, o sistema preenche a cadeia inteira
 * desde a admissao ate o mes-alvo antes de devolver o resultado.
 */

import { query } from '@/lib/db';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// ---------------------------------------------------------------------------
// Parametros (lidos do banco, com fallback para defaults)
// ---------------------------------------------------------------------------

export interface ParametrosAssiduidade {
  limitePontosZerar: number;
  minDiasAdmissaoMes: number;
  valorInicial: number;
  incrementoMensal: number;
  valorMaximo: number;
  cargosExcluidos: string[];
  ativo: boolean;
}

const DEFAULTS: ParametrosAssiduidade = {
  limitePontosZerar: 3,
  minDiasAdmissaoMes: 15,
  valorInicial: 100,
  incrementoMensal: 100,
  valorMaximo: 300,
  cargosExcluidos: [
    'Supervisor de Estoque',
    'Supervisor de Operações',
    'Gestor de Operações',
    'Coordenador de Operações',
  ],
  ativo: true,
};

/**
 * Le os parametros de assiduidade do banco (com cache).
 * Retorna defaults se nao houver registro.
 */
export async function obterParametrosAssiduidade(): Promise<ParametrosAssiduidade> {
  const cacheKey = `${CACHE_KEYS.PARAMETROS_ASSIDUIDADE}atual`;

  return cacheAside(cacheKey, async () => {
    const result = await query(
      `SELECT limite_pontos_zerar, min_dias_admissao_mes,
              valor_inicial, incremento_mensal, valor_maximo,
              cargos_excluidos, ativo
       FROM bluepoint.bt_parametros_assiduidade
       ORDER BY id DESC LIMIT 1`,
    );

    if (result.rows.length === 0) return DEFAULTS;

    const row = result.rows[0];
    return {
      limitePontosZerar: row.limite_pontos_zerar ?? DEFAULTS.limitePontosZerar,
      minDiasAdmissaoMes: row.min_dias_admissao_mes ?? DEFAULTS.minDiasAdmissaoMes,
      valorInicial: Number(row.valor_inicial ?? DEFAULTS.valorInicial),
      incrementoMensal: Number(row.incremento_mensal ?? DEFAULTS.incrementoMensal),
      valorMaximo: Number(row.valor_maximo ?? DEFAULTS.valorMaximo),
      cargosExcluidos: row.cargos_excluidos ?? DEFAULTS.cargosExcluidos,
      ativo: row.ativo ?? DEFAULTS.ativo,
    };
  }, CACHE_TTL.LONG);
}

/** Helper: verifica se um cargo esta na lista de excluidos */
export function isCargoExcluido(cargoNome: string | null, cargosExcluidos: string[]): boolean {
  if (!cargoNome) return false;
  const lower = cargoNome.toLowerCase();
  return cargosExcluidos.some((c) => c.toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface MesAno {
  mes: number;
  ano: number;
}

export interface ColaboradorParaCalculo {
  id: number;
  nome: string;
  cargo_nome: string | null;
  departamento_nome: string | null;
  data_admissao: string;
  bloqueado: boolean;
  excluido: boolean;
}

export interface ResultadoCalculo {
  colaborador_id: number;
  colaborador_nome: string;
  colaborador_cargo: string | null;
  colaborador_departamento: string | null;
  mes: number;
  ano: number;
  total_pontos: number;
  valor_total: number;
  dias_trabalhados: number;
  ocorrencias_periodo: number;
  observacoes: string | null;
}

/**
 * Função que fornece os pontos de um colaborador num dado mês/ano.
 * Deve ser injetada pelo caller (endpoint) — tipicamente consulta a API
 * externa de ocorrências ou usa um mapa recebido no body da request.
 */
export type BuscarPontosFn = (
  colaboradorId: number,
  mes: number,
  ano: number,
) => Promise<{ total_pontos: number; ocorrencias_periodo: number }>;

const PONTOS_ZERO: BuscarPontosFn = async () => ({
  total_pontos: 0,
  ocorrencias_periodo: 0,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbQueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

/**
 * Dias trabalhados no mês considerando data de admissão.
 *  - Admitido antes do mês → 30 (aproximação padrão)
 *  - Admitido no próprio mês → (último dia) - (dia admissão) + 1
 *  - Admitido depois do mês → 0
 */
export function calcularDiasTrabalhados(
  dataContratacao: Date | string,
  mes: number,
  ano: number,
): number {
  let anoC: number, mesC: number, diaC: number;

  if (typeof dataContratacao === 'string') {
    const [y, m, d] = dataContratacao.slice(0, 10).split('-').map(Number);
    anoC = y; mesC = m; diaC = d;
  } else {
    anoC = dataContratacao.getFullYear();
    mesC = dataContratacao.getMonth() + 1;
    diaC = dataContratacao.getDate();
  }

  if (anoC > ano || (anoC === ano && mesC > mes)) return 0;
  if (anoC < ano || mesC < mes) return 30;

  const ultimoDia = new Date(ano, mes, 0).getDate();
  return Math.max(0, ultimoDia - diaC + 1);
}

/**
 * Valor do bonus conforme regras de negocio (parametrizavel).
 */
export function calcularValorBonus(
  totalPontos: number,
  valorMesAnterior: number,
  diasTrabalhados: number,
  admitidoNesteMes: boolean,
  cargoExcluido: boolean,
  bloqueado: boolean,
  params: ParametrosAssiduidade = DEFAULTS,
): { valor: number; motivo: string } {
  if (bloqueado) {
    return { valor: 0, motivo: 'Colaborador bloqueado para assiduidade' };
  }
  if (cargoExcluido) {
    return { valor: 0, motivo: 'Cargo excluido de assiduidade' };
  }
  if (totalPontos > params.limitePontosZerar) {
    return {
      valor: 0,
      motivo: `Excedeu pontuacao (${totalPontos} pts > limite de ${params.limitePontosZerar})`,
    };
  }
  if (admitidoNesteMes) {
    if (diasTrabalhados < params.minDiasAdmissaoMes) {
      return {
        valor: 0,
        motivo: `Menos de ${params.minDiasAdmissaoMes} dias no mes de admissao (${diasTrabalhados} dias)`,
      };
    }
    return {
      valor: params.valorInicial,
      motivo: `Admitido no mes com ${diasTrabalhados} dias trabalhados`,
    };
  }

  const proximo = valorMesAnterior + params.incrementoMensal;
  const valor = Math.min(params.valorMaximo, proximo);
  return { valor, motivo: `Valor anterior R$${valorMesAnterior} + R$${params.incrementoMensal} = R$${valor}` };
}

// ---------------------------------------------------------------------------
// Helpers de período
// ---------------------------------------------------------------------------

function formatMesAno(mes: number, ano: number): string {
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

/**
 * Gera lista ordenada de {mes, ano} desde a admissão até o mês-alvo (inclusive).
 * Retorna array vazio se a admissão for posterior ao mês-alvo.
 */
export function gerarMesesDesdeAdmissao(
  dataAdmissao: string,
  mesAlvo: number,
  anoAlvo: number,
): MesAno[] {
  const [anoAdm, mesAdm] = dataAdmissao.slice(0, 10).split('-').map(Number);

  if (anoAdm > anoAlvo || (anoAdm === anoAlvo && mesAdm > mesAlvo)) return [];

  const meses: MesAno[] = [];
  let m = mesAdm;
  let a = anoAdm;
  while (a < anoAlvo || (a === anoAlvo && m <= mesAlvo)) {
    meses.push({ mes: m, ano: a });
    m++;
    if (m > 12) { m = 1; a++; }
  }
  return meses;
}

// ---------------------------------------------------------------------------
// Cadeia cronológica completa (com persistência)
// ---------------------------------------------------------------------------

/**
 * Calcula (e persiste) a cadeia cronológica completa de um colaborador
 * até o mês/ano alvo. Meses já calculados são reaproveitados;
 * meses faltantes são calculados em ordem e gravados via UPSERT.
 *
 * @param buscarPontos Callback que fornece os pontos de ocorrência.
 *                     Quando omitido, assume 0 pontos em todos os meses.
 */
export async function calcularCadeiaColaborador(
  dbQuery: DbQueryFn,
  colaborador: ColaboradorParaCalculo,
  mesAlvo: number,
  anoAlvo: number,
  buscarPontos: BuscarPontosFn = PONTOS_ZERO,
  params: ParametrosAssiduidade = DEFAULTS,
): Promise<ResultadoCalculo> {
  const todosMeses = gerarMesesDesdeAdmissao(colaborador.data_admissao, mesAlvo, anoAlvo);

  if (todosMeses.length === 0) {
    const obs = 'Admissão posterior ao mês de cálculo';
    await persistirRegistro(dbQuery, colaborador, mesAlvo, anoAlvo, {
      total_pontos: 0, valor_total: 0, dias_trabalhados: 0, ocorrencias_periodo: 0, observacoes: obs,
    });
    return buildResultado(colaborador, mesAlvo, anoAlvo, 0, 0, 0, 0, obs);
  }

  const existentes = await dbQuery(
    `SELECT mes, ano, valor_total
     FROM bluepoint.bt_historico_assiduidade
     WHERE colaborador_id = $1 ORDER BY ano, mes`,
    [colaborador.id],
  );
  const existenteMap = new Map<string, number>();
  for (const r of existentes.rows) {
    existenteMap.set(`${r.mes}-${r.ano}`, Number(r.valor_total));
  }

  let valorAnterior = 0;
  let resultado: ResultadoCalculo | null = null;

  for (const { mes, ano } of todosMeses) {
    const chave = `${mes}-${ano}`;

    if (existenteMap.has(chave)) {
      valorAnterior = existenteMap.get(chave)!;
      if (mes === mesAlvo && ano === anoAlvo) {
        const reg = await dbQuery(
          `SELECT total_pontos, valor_total, dias_trabalhados, ocorrencias_periodo, observacoes
           FROM bluepoint.bt_historico_assiduidade
           WHERE colaborador_id = $1 AND mes = $2 AND ano = $3`,
          [colaborador.id, mes, ano],
        );
        const r = reg.rows[0];
        resultado = buildResultado(
          colaborador, mes, ano,
          Number(r?.total_pontos ?? 0), Number(r?.valor_total ?? 0),
          Number(r?.dias_trabalhados ?? 0), Number(r?.ocorrencias_periodo ?? 0),
          (r?.observacoes as string) ?? null,
        );
      }
      continue;
    }

    const { total_pontos, ocorrencias_periodo } = await buscarPontos(colaborador.id, mes, ano);
    const calc = await calcularMesIndividual(
      dbQuery, colaborador, mes, ano, valorAnterior, total_pontos, ocorrencias_periodo, params,
    );
    valorAnterior = calc.valor_total;
    existenteMap.set(chave, calc.valor_total);

    if (mes === mesAlvo && ano === anoAlvo) {
      resultado = calc;
    }
  }

  return resultado!;
}

// ---------------------------------------------------------------------------
// Cálculo de um único mês (aplica regras, persiste)
// ---------------------------------------------------------------------------

async function calcularMesIndividual(
  dbQuery: DbQueryFn,
  colaborador: ColaboradorParaCalculo,
  mes: number,
  ano: number,
  valorMesAnterior: number,
  totalPontos: number,
  ocorrenciasPeriodo: number,
  params: ParametrosAssiduidade = DEFAULTS,
): Promise<ResultadoCalculo> {
  const diasTrabalhados = calcularDiasTrabalhados(colaborador.data_admissao, mes, ano);
  const admitidoNesteMes = colaborador.data_admissao.slice(0, 7) === formatMesAno(mes, ano);

  const { valor, motivo } = calcularValorBonus(
    totalPontos, valorMesAnterior, diasTrabalhados,
    admitidoNesteMes, colaborador.excluido, colaborador.bloqueado, params,
  );

  await persistirRegistro(dbQuery, colaborador, mes, ano, {
    total_pontos: totalPontos,
    valor_total: valor,
    dias_trabalhados: diasTrabalhados,
    ocorrencias_periodo: ocorrenciasPeriodo,
    observacoes: motivo,
  });

  return buildResultado(
    colaborador, mes, ano,
    totalPontos, valor, diasTrabalhados, ocorrenciasPeriodo, motivo,
  );
}

// ---------------------------------------------------------------------------
// Persistência (UPSERT)
// ---------------------------------------------------------------------------

async function persistirRegistro(
  dbQuery: DbQueryFn,
  colaborador: ColaboradorParaCalculo,
  mes: number,
  ano: number,
  dados: {
    total_pontos: number;
    valor_total: number;
    dias_trabalhados: number;
    ocorrencias_periodo: number;
    observacoes: string | null;
  },
): Promise<void> {
  await dbQuery(
    `INSERT INTO bluepoint.bt_historico_assiduidade (
       colaborador_id, mes, ano,
       total_pontos, valor_ponto, valor_base, valor_bonus, valor_total,
       dias_trabalhados, ocorrencias_periodo, pontuacao_ocorrencias,
       colaborador_nome, colaborador_cargo, colaborador_departamento,
       observacoes, status
     ) VALUES ($1,$2,$3,$4,0,0,$5,$5,$6,$7,$4,$8,$9,$10,$11,'calculado')
     ON CONFLICT (colaborador_id, mes, ano) DO UPDATE SET
       total_pontos            = EXCLUDED.total_pontos,
       valor_bonus             = EXCLUDED.valor_bonus,
       valor_total             = EXCLUDED.valor_total,
       dias_trabalhados        = EXCLUDED.dias_trabalhados,
       ocorrencias_periodo     = EXCLUDED.ocorrencias_periodo,
       pontuacao_ocorrencias   = EXCLUDED.pontuacao_ocorrencias,
       colaborador_nome        = EXCLUDED.colaborador_nome,
       colaborador_cargo       = EXCLUDED.colaborador_cargo,
       colaborador_departamento= EXCLUDED.colaborador_departamento,
       observacoes             = EXCLUDED.observacoes,
       atualizado_em           = CURRENT_TIMESTAMP`,
    [
      colaborador.id, mes, ano,
      dados.total_pontos,
      dados.valor_total,
      dados.dias_trabalhados,
      dados.ocorrencias_periodo,
      colaborador.nome,
      colaborador.cargo_nome,
      colaborador.departamento_nome,
      dados.observacoes,
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function buildResultado(
  col: ColaboradorParaCalculo,
  mes: number, ano: number,
  totalPontos: number, valorTotal: number,
  diasTrabalhados: number, ocorrencias: number,
  obs: string | null,
): ResultadoCalculo {
  return {
    colaborador_id: col.id,
    colaborador_nome: col.nome,
    colaborador_cargo: col.cargo_nome,
    colaborador_departamento: col.departamento_nome,
    mes, ano,
    total_pontos: totalPontos,
    valor_total: valorTotal,
    dias_trabalhados: diasTrabalhados,
    ocorrencias_periodo: ocorrencias,
    observacoes: obs,
  };
}
