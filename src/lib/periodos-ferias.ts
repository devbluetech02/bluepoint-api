import { query } from './db';

/**
 * Retorna o conjunto de datas (YYYY-MM-DD) em que o colaborador está em férias aprovadas
 * dentro do período [dataInicio, dataFim]. Usado para não contar esses dias como falta.
 */
export async function getDiasEmFeriasNoPeriodo(
  colaboradorId: number,
  dataInicio: string,
  dataFim: string
): Promise<Set<string>> {
  const result = await query(
    `SELECT data_inicio, data_fim
     FROM bluepoint.bt_periodos_ferias
     WHERE colaborador_id = $1
       AND data_fim >= $2::date
       AND data_inicio <= $3::date`,
    [colaboradorId, dataInicio, dataFim]
  );

  const dias = new Set<string>();
  const [y1, m1, d1] = dataInicio.split('-').map(Number);
  const [y2, m2, d2] = dataFim.split('-').map(Number);
  const inicio = new Date(y1, m1 - 1, d1);
  const fim = new Date(y2, m2 - 1, d2);

  for (const row of result.rows) {
    const perIni = String(row.data_inicio).substring(0, 10);
    const perFim = String(row.data_fim).substring(0, 10);
    const [py1, pm1, pd1] = perIni.split('-').map(Number);
    const [py2, pm2, pd2] = perFim.split('-').map(Number);
    const pIni = new Date(py1, pm1 - 1, pd1);
    const pFim = new Date(py2, pm2 - 1, pd2);
    const from = pIni < inicio ? inicio : pIni;
    const to = pFim > fim ? fim : pFim;
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const str = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dias.add(str);
    }
  }
  return dias;
}

/**
 * Verifica se o colaborador está em férias aprovadas em uma data específica.
 */
export async function estaEmFeriasAprovadas(
  colaboradorId: number,
  dataStr: string
): Promise<boolean> {
  const dias = await getDiasEmFeriasNoPeriodo(colaboradorId, dataStr, dataStr);
  return dias.has(dataStr);
}
