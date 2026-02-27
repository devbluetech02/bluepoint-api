import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { gerarUrlPublica } from '@/lib/storage';
import { getDiasEmFeriasNoPeriodo } from '@/lib/periodos-ferias';

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
  if (porDiasSemana) return porDiasSemana;

  return undefined;
}

function parseTimestamp(ts: string): Date | null {
  if (!ts) return null;
  const normalized = ts.replace('T', ' ').replace(/\.\d+/, '');
  const [datePart, timePart] = normalized.split(' ');
  if (!datePart || !timePart) return null;
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, min, s] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatHoraMinuto(hora: string): string {
  if (!hora) return '';
  if (hora.includes(' ')) {
    const timePart = hora.split(' ')[1];
    return timePart.substring(0, 5);
  }
  return hora.substring(0, 5);
}

function minutosParaHHMM(minutos: number): string {
  const h = Math.floor(Math.abs(minutos) / 60);
  const m = Math.round(Math.abs(minutos) % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minutosParaSaldo(minutos: number): string {
  const sign = minutos >= 0 ? '+' : '-';
  return `${sign}${minutosParaHHMM(minutos)}`;
}

function calcularMinutosTrabalhados(marcacoes: Array<{ data_hora: string; tipo: string }>): number {
  let totalMinutos = 0;
  const entradas: string[] = [];
  const saidas: string[] = [];

  for (const m of marcacoes) {
    if (m.tipo === 'entrada' || m.tipo === 'retorno') {
      entradas.push(m.data_hora);
    } else if (m.tipo === 'saida' || m.tipo === 'almoco') {
      saidas.push(m.data_hora);
    }
  }

  const pares = Math.min(entradas.length, saidas.length);
  for (let i = 0; i < pares; i++) {
    const entrada = parseTimestamp(entradas[i]);
    const saida = parseTimestamp(saidas[i]);
    if (entrada && saida) {
      const diff = (saida.getTime() - entrada.getTime()) / (1000 * 60);
      if (diff > 0) totalMinutos += diff;
    }
  }

  return totalMinutos;
}

function calcularCargaPrevista(periodos: Periodo[] | null): number {
  if (!periodos || periodos.length === 0) return 0;
  let total = 0;
  for (const p of periodos) {
    const [eh, em] = p.entrada.split(':').map(Number);
    const [sh, sm] = p.saida.split(':').map(Number);
    total += (sh * 60 + sm) - (eh * 60 + em);
  }
  return total;
}

function gerarDiasDoMes(mes: number, ano: number): string[] {
  const dias: string[] = [];
  const ultimoDia = new Date(ano, mes, 0).getDate();
  for (let d = 1; d <= ultimoDia; d++) {
    const m = String(mes).padStart(2, '0');
    const day = String(d).padStart(2, '0');
    dias.push(`${ano}-${m}-${day}`);
  }
  return dias;
}

function getDiaSemanaFromDate(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

function mapTipoMarcacao(tipo: string): string {
  const mapa: Record<string, string> = {
    entrada: 'entrada',
    almoco: 'almoco_inicio',
    retorno: 'almoco_fim',
    saida: 'saida',
  };
  return mapa[tipo] || tipo;
}

async function garantirTabela(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bluepoint.bt_relatorios_mensais (
      id SERIAL PRIMARY KEY,
      colaborador_id INTEGER NOT NULL,
      mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
      ano INTEGER NOT NULL CHECK (ano BETWEEN 2020 AND 2100),
      status VARCHAR(20) NOT NULL DEFAULT 'pendente',
      dias_trabalhados INTEGER DEFAULT 0,
      horas_trabalhadas VARCHAR(10) DEFAULT '00:00',
      horas_extras VARCHAR(10) DEFAULT '00:00',
      banco_horas VARCHAR(10) DEFAULT '+00:00',
      faltas INTEGER DEFAULT 0,
      atrasos INTEGER DEFAULT 0,
      total_atrasos VARCHAR(10) DEFAULT '00:00',
      assinado_em TIMESTAMP NULL,
      dispositivo VARCHAR(255) NULL,
      localizacao_gps VARCHAR(60) NULL,
      assinatura_imagem TEXT NULL,
      ip_address VARCHAR(45) NULL,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE (colaborador_id, mes, ano)
    )
  `);

  const colCheck = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'bluepoint' AND table_name = 'bt_relatorios_mensais' AND column_name = 'localizacao_gps'
  `);
  if (colCheck.rows.length === 0) {
    await query(`ALTER TABLE bluepoint.bt_relatorios_mensais ADD COLUMN localizacao_gps VARCHAR(60) NULL`);
    await query(`ALTER TABLE bluepoint.bt_relatorios_mensais ADD COLUMN assinatura_imagem TEXT NULL`);
    await query(`ALTER TABLE bluepoint.bt_relatorios_mensais ADD COLUMN ip_address VARCHAR(45) NULL`);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (req: NextRequest, _user: JWTPayload) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);
      if (isNaN(colaboradorId)) {
        return errorResponse('ID do colaborador inválido', 400);
      }

      const { searchParams } = new URL(req.url);
      const mesParam = searchParams.get('mes');
      const anoParam = searchParams.get('ano');

      if (!mesParam || !anoParam) {
        return errorResponse('Parâmetros mes e ano são obrigatórios', 400);
      }

      const mes = parseInt(mesParam);
      const ano = parseInt(anoParam);

      if (mes < 1 || mes > 12) {
        return errorResponse('Mês deve ser entre 1 e 12', 400);
      }
      if (ano < 2020 || ano > 2100) {
        return errorResponse('Ano inválido', 400);
      }

      const colabResult = await query(
        `SELECT c.id, c.nome, c.jornada_id
         FROM bluepoint.bt_colaboradores c
         WHERE c.id = $1`,
        [colaboradorId]
      );

      if (colabResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      const colab = colabResult.rows[0];

      let jornadaHorarios: JornadaHorario[] = [];
      if (colab.jornada_id) {
        const jornadaResult = await query(
          `SELECT dia_semana, dias_semana, folga, periodos
           FROM bluepoint.bt_jornada_horarios
           WHERE jornada_id = $1
           ORDER BY COALESCE(dia_semana, sequencia, id)`,
          [colab.jornada_id]
        );
        jornadaHorarios = jornadaResult.rows.map(r => ({
          dia_semana: r.dia_semana ?? null,
          dias_semana: r.dias_semana
            ? (typeof r.dias_semana === 'string' ? JSON.parse(r.dias_semana) : r.dias_semana)
            : null,
          folga: r.folga,
          periodos: typeof r.periodos === 'string' ? JSON.parse(r.periodos) : r.periodos,
        }));
      }

      const mesStr = String(mes).padStart(2, '0');
      const dataInicio = `${ano}-${mesStr}-01`;
      const ultimoDia = new Date(ano, mes, 0).getDate();
      const dataFim = `${ano}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;

      const marcacoesResult = await query(
        `SELECT data_hora, tipo
         FROM bluepoint.bt_marcacoes
         WHERE colaborador_id = $1
           AND data_hora >= $2
           AND data_hora < ($3::date + interval '1 day')
         ORDER BY data_hora`,
        [colaboradorId, dataInicio, dataFim]
      );

      const marcacoesPorDia = new Map<string, Array<{ data_hora: string; tipo: string }>>();
      for (const m of marcacoesResult.rows) {
        const dataStr = String(m.data_hora).substring(0, 10);
        if (!marcacoesPorDia.has(dataStr)) {
          marcacoesPorDia.set(dataStr, []);
        }
        marcacoesPorDia.get(dataStr)!.push({ data_hora: String(m.data_hora), tipo: m.tipo });
      }

      const bancoResult = await query(
        `SELECT COALESCE(SUM(
          CASE WHEN tipo IN ('credito', 'ajuste') THEN horas
               WHEN tipo IN ('debito', 'compensacao') THEN -horas
               ELSE 0 END
        ), 0) as saldo
         FROM bluepoint.bt_banco_horas
         WHERE colaborador_id = $1
           AND data >= $2 AND data <= $3`,
        [colaboradorId, dataInicio, dataFim]
      );
      const saldoBancoMinutos = Math.round(parseFloat(bancoResult.rows[0].saldo) * 60);

      const diasDoMes = gerarDiasDoMes(mes, ano);
      let totalDiasTrabalhados = 0;
      let totalMinutosTrabalhados = 0;
      let totalMinutosExtras = 0;
      let totalFaltas = 0;
      let totalAtrasos = 0;
      let totalMinutosAtrasos = 0;

      const feriasPorDia = await getDiasEmFeriasNoPeriodo(colaboradorId, dataInicio, dataFim);

      const dias = [];

      for (const diaStr of diasDoMes) {
        const diaSemana = getDiaSemanaFromDate(diaStr);
        const horarioDia = encontrarHorarioDia(jornadaHorarios, diaSemana);
        const isFolga = horarioDia ? horarioDia.folga : false;
        const temEscala = !!horarioDia && !isFolga;
        const marcacoesDia = marcacoesPorDia.get(diaStr) || [];

        const minutosTrab = calcularMinutosTrabalhados(marcacoesDia);
        const cargaPrevista = temEscala ? calcularCargaPrevista(horarioDia!.periodos) : 0;

        let horasExtrasDia = 0;
        let saldoDia = 0;
        let atrasoDia = 0;

        if (marcacoesDia.length > 0) {
          totalDiasTrabalhados++;
          totalMinutosTrabalhados += minutosTrab;

          if (temEscala && cargaPrevista > 0) {
            if (minutosTrab > cargaPrevista) {
              horasExtrasDia = minutosTrab - cargaPrevista;
              totalMinutosExtras += horasExtrasDia;
            }
            saldoDia = minutosTrab - cargaPrevista;

            if (horarioDia!.periodos && horarioDia!.periodos.length > 0 && marcacoesDia.length > 0) {
              const primeiraEntrada = marcacoesDia.find(m => m.tipo === 'entrada');
              if (primeiraEntrada) {
                const horaEntrada = formatHoraMinuto(primeiraEntrada.data_hora);
                const horaPrevista = horarioDia!.periodos[0].entrada;
                const [eh, em] = horaEntrada.split(':').map(Number);
                const [ph, pm] = horaPrevista.split(':').map(Number);
                const diffMinutos = (eh * 60 + em) - (ph * 60 + pm);
                if (diffMinutos > 0) {
                  totalAtrasos++;
                  atrasoDia = diffMinutos;
                  totalMinutosAtrasos += diffMinutos;
                }
              }
            }
          } else {
            horasExtrasDia = minutosTrab;
            totalMinutosExtras += horasExtrasDia;
            saldoDia = minutosTrab;
          }
        } else if (temEscala && !feriasPorDia.has(diaStr)) {
          totalFaltas++;
          saldoDia = -cargaPrevista;
        }

        const marcacoesFormatadas = marcacoesDia.map(m => ({
          tipo: mapTipoMarcacao(m.tipo),
          hora: formatHoraMinuto(m.data_hora),
        }));

        dias.push({
          data: diaStr,
          marcacoes: marcacoesFormatadas,
          horasTrabalhadas: minutosParaHHMM(minutosTrab),
          horasExtras: minutosParaHHMM(horasExtrasDia),
          saldo: minutosParaSaldo(saldoDia),
          observacao: atrasoDia > 0 ? `Atraso de ${minutosParaHHMM(atrasoDia)}` : null,
        });
      }

      await garantirTabela();

      const client = await getClient();
      try {
        await client.query('BEGIN');

        const upsertResult = await client.query(
          `INSERT INTO bluepoint.bt_relatorios_mensais
            (colaborador_id, mes, ano, dias_trabalhados, horas_trabalhadas, horas_extras, banco_horas, faltas, atrasos, total_atrasos, atualizado_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           ON CONFLICT (colaborador_id, mes, ano)
           DO UPDATE SET
             dias_trabalhados = EXCLUDED.dias_trabalhados,
             horas_trabalhadas = EXCLUDED.horas_trabalhadas,
             horas_extras = EXCLUDED.horas_extras,
             banco_horas = EXCLUDED.banco_horas,
             faltas = EXCLUDED.faltas,
             atrasos = EXCLUDED.atrasos,
             total_atrasos = EXCLUDED.total_atrasos,
             atualizado_em = NOW()
           WHERE bluepoint.bt_relatorios_mensais.status = 'pendente'
           RETURNING id, status, assinado_em, dispositivo, localizacao_gps, assinatura_imagem, ip_address`,
          [
            colaboradorId, mes, ano,
            totalDiasTrabalhados,
            minutosParaHHMM(totalMinutosTrabalhados),
            minutosParaHHMM(totalMinutosExtras),
            minutosParaSaldo(saldoBancoMinutos),
            totalFaltas, totalAtrasos,
            minutosParaHHMM(totalMinutosAtrasos),
          ]
        );

        await client.query('COMMIT');

        let relatorio;
        if (upsertResult.rows.length > 0) {
          relatorio = upsertResult.rows[0];
        } else {
          const existente = await query(
            `SELECT id, status, assinado_em, dispositivo, localizacao_gps, assinatura_imagem, ip_address
             FROM bluepoint.bt_relatorios_mensais WHERE colaborador_id = $1 AND mes = $2 AND ano = $3`,
            [colaboradorId, mes, ano]
          );
          relatorio = existente.rows[0];
        }

        const assinatura = relatorio.assinado_em ? {
          assinadoEm: relatorio.assinado_em,
          colaboradorNome: colab.nome,
          dispositivo: relatorio.dispositivo || null,
          localizacao: relatorio.localizacao_gps || null,
          possuiImagemAssinatura: !!relatorio.assinatura_imagem,
          imagemUrl: relatorio.assinatura_imagem
            ? gerarUrlPublica(`assinaturas/${colaboradorId}/${relatorio.id}.png`)
            : null,
        } : null;

        return successResponse({
          id: relatorio.id,
          colaboradorId,
          mes,
          ano,
          status: relatorio.status,
          diasTrabalhados: totalDiasTrabalhados,
          horasTrabalhadas: minutosParaHHMM(totalMinutosTrabalhados),
          horasExtras: minutosParaHHMM(totalMinutosExtras),
          bancoHoras: minutosParaSaldo(saldoBancoMinutos),
          faltas: totalFaltas,
          atrasos: totalAtrasos,
          totalAtrasos: minutosParaHHMM(totalMinutosAtrasos),
          assinadoEm: relatorio.assinado_em || null,
          assinatura,
          dias,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Erro ao obter relatório mensal:', error);
      return serverErrorResponse('Erro ao obter relatório mensal');
    }
  });
}
