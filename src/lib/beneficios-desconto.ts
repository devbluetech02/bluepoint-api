import { query } from './db';
import { getDiasEmFeriasNoPeriodo } from './periodos-ferias';

interface Periodo {
  entrada: string;
  saida: string;
}

interface JornadaHorario {
  dia_semana: number | null;
  dias_semana: number[] | null;
  folga: boolean;
  periodos: Periodo[] | null;
}

function getDiaSemanaFromDate(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

function encontrarHorarioDia(
  jornadaHorarios: JornadaHorario[],
  diaSemana: number
): JornadaHorario | undefined {
  const porDiaSemana = jornadaHorarios.find(
    h => h.dia_semana !== null && h.dia_semana !== undefined && h.dia_semana === diaSemana
  );
  if (porDiaSemana) return porDiaSemana;
  const porDiasSemana = jornadaHorarios.find(h => {
    if (!h.dias_semana || !Array.isArray(h.dias_semana)) return false;
    return h.dias_semana.includes(diaSemana);
  });
  return porDiasSemana;
}

function calcularMinutosTrabalhados(marcacoes: Array<{ data_hora: string; tipo: string }>): number {
  let totalMinutos = 0;
  const entradas: string[] = [];
  const saidas: string[] = [];
  for (const m of marcacoes) {
    if (m.tipo === 'entrada' || m.tipo === 'retorno') entradas.push(m.data_hora);
    else if (m.tipo === 'saida' || m.tipo === 'almoco') saidas.push(m.data_hora);
  }
  const pares = Math.min(entradas.length, saidas.length);
  for (let i = 0; i < pares; i++) {
    const e = entradas[i].replace('T', ' ').replace(/\.\d+/, '').split(' ');
    const s = saidas[i].replace('T', ' ').replace(/\.\d+/, '').split(' ');
    if (e[0] && e[1] && s[0] && s[1]) {
      const [ey, emo, ed] = e[0].split('-').map(Number);
      const [eh, emi] = e[1].split(':').map(Number);
      const [sy, smo, sd] = s[0].split('-').map(Number);
      const [sh, smi] = s[1].split(':').map(Number);
      const entrada = new Date(ey, emo - 1, ed, eh, emi, 0);
      const saida = new Date(sy, smo - 1, sd, sh, smi, 0);
      const diff = (saida.getTime() - entrada.getTime()) / (1000 * 60);
      if (diff > 0) totalMinutos += diff;
    }
  }
  return totalMinutos;
}

function gerarDiasDoMes(mes: number, ano: number): string[] {
  const dias: string[] = [];
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const mStr = String(mes).padStart(2, '0');
  for (let d = 1; d <= ultimoDia; d++) {
    dias.push(`${ano}-${mStr}-${String(d).padStart(2, '0')}`);
  }
  return dias;
}

/**
 * Calcula dias a descontar para benefícios (VA/VT) por colaborador no mês.
 * Considera: faltas (dia útil com jornada sem marcação), atestados/ausências aprovados,
 * e dias com carga < horasMinimas (contam como 1 dia de desconto).
 */
export async function getDiasDescontoPorColaborador(
  ano: number,
  mes: number,
  colaboradorIds: number[],
  horasMinimas: number
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (colaboradorIds.length === 0) return result;

  const dataInicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const dataFim = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
  const minutosMinimos = horasMinimas * 60;
  const diasDoMes = gerarDiasDoMes(mes, ano);

  for (const id of colaboradorIds) {
    result.set(id, 0);
  }

  const [feriadosRes, marcacoesRes, solicitacoesRes, colabJornadaRes] = await Promise.all([
    query(
      `SELECT data::text as data FROM bluepoint.bt_feriados
       WHERE data >= $1::date AND data <= $2::date`,
      [dataInicio, dataFim]
    ),
    query(
      `SELECT colaborador_id, data_hora::text as data_hora, tipo
       FROM bluepoint.bt_marcacoes
       WHERE colaborador_id = ANY($1::int[])
         AND data_hora >= $2 AND data_hora < ($3::date + interval '1 day')`,
      [colaboradorIds, dataInicio, dataFim]
    ),
    query(
      `SELECT colaborador_id, data_evento::text as data_evento,
              data_evento_fim::text as data_evento_fim
       FROM bluepoint.bt_solicitacoes
       WHERE colaborador_id = ANY($1::int[])
         AND tipo IN ('atestado', 'ausencia')
         AND status = 'aprovada'
         AND (
           (data_evento <= $3 AND COALESCE(data_evento_fim, data_evento) >= $2)
         )`,
      [colaboradorIds, dataInicio, dataFim]
    ),
    query(
      `SELECT id, jornada_id FROM bluepoint.bt_colaboradores WHERE id = ANY($1::int[])`,
      [colaboradorIds]
    ),
  ]);

  const feriadosSet = new Set(feriadosRes.rows.map(r => r.data?.substring(0, 10)).filter(Boolean));

  const marcacoesPorColabEDia = new Map<string, Array<{ data_hora: string; tipo: string }>>();
  for (const m of marcacoesRes.rows) {
    const dataStr = String(m.data_hora).substring(0, 10);
    const key = `${m.colaborador_id}:${dataStr}`;
    if (!marcacoesPorColabEDia.has(key)) marcacoesPorColabEDia.set(key, []);
    marcacoesPorColabEDia.get(key)!.push({ data_hora: m.data_hora, tipo: m.tipo });
  }

  const diasAtestadoAusenciaPorColab = new Map<number, number>();
  for (const s of solicitacoesRes.rows) {
    const de = s.data_evento?.substring(0, 10) || '';
    const ate = (s.data_evento_fim || s.data_evento)?.substring(0, 10) || de;
    let dias = 0;
    for (const diaStr of diasDoMes) {
      if (diaStr >= de && diaStr <= ate) dias++;
    }
    diasAtestadoAusenciaPorColab.set(
      s.colaborador_id,
      (diasAtestadoAusenciaPorColab.get(s.colaborador_id) || 0) + dias
    );
  }

  const jornadaIds = [...new Set(colabJornadaRes.rows.map(r => r.jornada_id).filter(Boolean))] as number[];
  const jornadaHorariosPorJornada = new Map<number, JornadaHorario[]>();

  if (jornadaIds.length > 0) {
    const jhRes = await query(
      `SELECT jornada_id, dia_semana, dias_semana, folga, periodos
       FROM bluepoint.bt_jornada_horarios
       WHERE jornada_id = ANY($1::int[])
       ORDER BY jornada_id, COALESCE(dia_semana, 0)`,
      [jornadaIds]
    );
    for (const r of jhRes.rows) {
      const list = jornadaHorariosPorJornada.get(r.jornada_id) || [];
      list.push({
        dia_semana: r.dia_semana ?? null,
        dias_semana: Array.isArray(r.dias_semana) ? r.dias_semana : (typeof r.dias_semana === 'string' ? JSON.parse(r.dias_semana) : null),
        folga: r.folga,
        periodos: typeof r.periodos === 'string' ? JSON.parse(r.periodos) : r.periodos,
      });
      jornadaHorariosPorJornada.set(r.jornada_id, list);
    }
  }

  const colabPorId = new Map(colabJornadaRes.rows.map(r => [r.id, r]));

  const feriasPorColab = new Map<number, Set<string>>();
  await Promise.all(
    colaboradorIds.map(async (cid) => {
      const set = await getDiasEmFeriasNoPeriodo(cid, dataInicio, dataFim);
      feriasPorColab.set(cid, set);
    })
  );

  for (const colaboradorId of colaboradorIds) {
    let diasDesconto = diasAtestadoAusenciaPorColab.get(colaboradorId) || 0;
    const colab = colabPorId.get(colaboradorId);
    const jornadaId = colab?.jornada_id;
    const jornadaHorarios = jornadaId ? jornadaHorariosPorJornada.get(jornadaId) || [] : [];
    const semJornada = jornadaHorarios.length === 0;

    for (const diaStr of diasDoMes) {
      if (feriadosSet.has(diaStr)) continue;
      const diaSemana = getDiaSemanaFromDate(diaStr);
      let temEscala: boolean;
      if (semJornada) {
        // Sem jornada cadastrada: considera seg–sex como dia útil (0=dom, 6=sáb)
        temEscala = diaSemana >= 1 && diaSemana <= 5;
      } else {
        const horarioDia = encontrarHorarioDia(jornadaHorarios, diaSemana);
        const isFolga = horarioDia ? horarioDia.folga : true;
        temEscala = !!horarioDia && !isFolga;
      }
      if (!temEscala) continue;

      const key = `${colaboradorId}:${diaStr}`;
      const marcacoesDia = marcacoesPorColabEDia.get(key) || [];
      const isFerias = feriasPorColab.get(colaboradorId)?.has(diaStr);

      if (marcacoesDia.length === 0) {
        // Dia útil sem marcação:
        // - se estiver em férias, não deve haver benefício (ex.: VT) nesse dia;
        // - se não estiver em férias, trata como falta para fins de benefícios.
        if (isFerias) {
          diasDesconto += 1;
        } else {
          diasDesconto += 1;
        }
      } else {
        const minutosTrab = calcularMinutosTrabalhados(marcacoesDia);
        if (minutosTrab < minutosMinimos) diasDesconto += 1;
      }
    }

    result.set(colaboradorId, Math.round(diasDesconto * 100) / 100);
  }

  return result;
}
