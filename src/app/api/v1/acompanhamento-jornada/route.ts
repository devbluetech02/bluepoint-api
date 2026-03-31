import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import {
  serverErrorResponse,
  errorResponse,
  buildPaginatedResponse,
} from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// =====================================================
// HELPERS
// =====================================================

const DIA_LABELS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

/**
 * Calcula o range segunda–domingo a partir de qualquer dia da semana.
 */
function calcularSemana(dataRef?: string): { segunda: string; domingo: string; datas: string[] } {
  const date = dataRef ? new Date(dataRef + 'T12:00:00') : new Date();
  const dow = date.getDay(); // 0=dom, 1=seg … 6=sab
  const diffToMonday = dow === 0 ? -6 : 1 - dow;

  const monday = new Date(date);
  monday.setDate(date.getDate() + diffToMonday);

  const datas: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    datas.push(d.toISOString().split('T')[0]);
  }

  return { segunda: datas[0], domingo: datas[6], datas };
}

/**
 * Calcula total de horas esperadas a partir dos períodos de uma jornada.
 */
function calcularHorasEsperadas(periodos: Array<{ entrada: string; saida: string }>): number {
  if (!periodos?.length) return 0;

  let totalMin = 0;
  for (const p of periodos) {
    const [hE, mE] = p.entrada.split(':').map(Number);
    const [hS, mS] = p.saida.split(':').map(Number);
    totalMin += (hS * 60 + mS) - (hE * 60 + mE);
  }

  return Math.round((totalMin / 60) * 100) / 100;
}

/**
 * Calcula horas trabalhadas a partir das marcações de um dia.
 * Quando `incluirEmAndamento` é true, conta tempo desde a última entrada
 * (sem saída correspondente) até `agoraMs`.
 */
function calcularHorasTrabalhadas(
  marcacoes: Array<{ data_hora: string; tipo: string }>,
  agoraMs: number,
  incluirEmAndamento: boolean
): number {
  if (!marcacoes.length) return 0;

  let totalMin = 0;
  let entradaMs: number | null = null;

  for (const m of marcacoes) {
    const ts = new Date(m.data_hora.replace(' ', 'T')).getTime();
    // 'entrada' e 'retorno' são tipos de início de período
    if (m.tipo === 'entrada' || m.tipo === 'retorno') {
      entradaMs = ts;
    // 'saida' e 'almoco' são tipos de fim de período
    } else if ((m.tipo === 'saida' || m.tipo === 'almoco') && entradaMs !== null) {
      totalMin += (ts - entradaMs) / 60000;
      entradaMs = null;
    }
  }

  // Período aberto (entrada/retorno sem saída/almoco) — soma até agora se for hoje
  if (entradaMs !== null && incluirEmAndamento) {
    totalMin += (agoraMs - entradaMs) / 60000;
  }

  return Math.round((totalMin / 60) * 100) / 100;
}

/**
 * Verifica se uma data cai em feriado (incluindo recorrentes).
 */
function verificarFeriado(
  dateStr: string,
  feriados: Array<{ data: string; recorrente: boolean }>
): boolean {
  const mmdd = dateStr.substring(5); // "MM-DD"
  return feriados.some(f => {
    if (f.data === dateStr) return true;
    if (f.recorrente && f.data.substring(5) === mmdd) return true;
    return false;
  });
}

// =====================================================
// GET /api/v1/acompanhamento-jornada
// =====================================================

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);

      // ---------- Parâmetros ----------
      const semanaParam = searchParams.get('semana');
      const empresaId = searchParams.get('empresaId');
      const departamentoId = searchParams.get('departamentoId');
      const busca = searchParams.get('busca');
      const apenasComMarcacao = searchParams.get('apenasComMarcacao') === 'true';
      const pagina = Math.max(1, parseInt(searchParams.get('pagina') || '1'));
      const limite = Math.min(100, Math.max(1, parseInt(searchParams.get('limite') || '20')));
      const offset = (pagina - 1) * limite;

      // Validar formato da semana
      if (semanaParam && !/^\d{4}-\d{2}-\d{2}$/.test(semanaParam)) {
        return errorResponse('Parâmetro "semana" deve estar no formato YYYY-MM-DD');
      }

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.MARCACOES, {
        tipo: 'acompanhamento', semana: semanaParam, empresaId, departamentoId,
        busca, apenasComMarcacao, pagina, limite,
      });

      const resultado = await cacheAside(cacheKey, async () => {

      // ---------- Calcular semana (seg–dom) ----------
      const { segunda, domingo, datas } = calcularSemana(semanaParam || undefined);

      // Obter data/hora atual do banco (timezone America/Sao_Paulo)
      const nowResult = await query(
        "SELECT NOW()::timestamp as agora, CURRENT_DATE::text as hoje"
      );
      const agoraStr = nowResult.rows[0].agora as string;
      const hoje = nowResult.rows[0].hoje as string;
      const agoraMs = new Date(agoraStr.replace(' ', 'T')).getTime();

      // ---------- Filtros de colaboradores ----------
      const conditions: string[] = ["c.status = 'ativo'"];
      const params: unknown[] = [];
      let pi = 1;

      if (empresaId) {
        conditions.push(`c.empresa_id = $${pi}`);
        params.push(parseInt(empresaId));
        pi++;
      }

      if (departamentoId) {
        conditions.push(`c.departamento_id = $${pi}`);
        params.push(parseInt(departamentoId));
        pi++;
      }

      if (busca) {
        conditions.push(`(c.nome ILIKE $${pi} OR c.cpf ILIKE $${pi})`);
        params.push(`%${busca}%`);
        pi++;
      }

      if (apenasComMarcacao) {
        conditions.push(`c.id IN (
          SELECT DISTINCT colaborador_id
          FROM people.marcacoes
          WHERE data_hora::date = CURRENT_DATE
        )`);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;

      // ---------- Contar total ----------
      const countResult = await query(
        `SELECT COUNT(*) as total FROM people.colaboradores c ${where}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      if (total === 0) {
        return buildPaginatedResponse([], total, pagina, limite);
      }

      // ---------- Buscar colaboradores paginados ----------
      const colabResult = await query(
        `SELECT
           c.id, c.nome, c.cpf, c.foto_url, c.cargo_id, cg.nome AS cargo_nome, c.jornada_id,
           c.departamento_id, d.nome   AS departamento_nome,
           c.empresa_id,       e.nome_fantasia AS empresa_nome
         FROM people.colaboradores c
         LEFT JOIN people.cargos cg       ON c.cargo_id        = cg.id
         LEFT JOIN people.departamentos d ON c.departamento_id = d.id
         LEFT JOIN people.empresas e      ON c.empresa_id      = e.id
         ${where}
         ORDER BY c.nome ASC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limite, offset]
      );

      if (colabResult.rows.length === 0) {
        return buildPaginatedResponse([], total, pagina, limite);
      }

      const colabIds = colabResult.rows.map(r => r.id);
      const jornadaIds = [
        ...new Set(
          colabResult.rows.map(r => r.jornada_id).filter(Boolean) as number[]
        ),
      ];

      // Range de datas para buscar marcações (semana + hoje, caso hoje fora da semana)
      const hojeNaSemana = datas.includes(hoje);
      const dataInicio = !hojeNaSemana && hoje < segunda ? hoje : segunda;
      const dataFim = !hojeNaSemana && hoje > domingo ? hoje : domingo;

      // ---------- Buscar marcações ----------
      const marcResult = await query(
        `SELECT colaborador_id, data_hora, tipo, data_hora::date::text AS data
         FROM people.marcacoes
         WHERE colaborador_id = ANY($1)
           AND data_hora::date BETWEEN $2::date AND $3::date
         ORDER BY data_hora ASC`,
        [colabIds, dataInicio, dataFim]
      );

      // Indexar marcações: "colabId_data" → marcação[]
      const marcMap = new Map<string, Array<{ data_hora: string; tipo: string }>>();
      for (const m of marcResult.rows) {
        const key = `${m.colaborador_id}_${m.data}`;
        if (!marcMap.has(key)) marcMap.set(key, []);
        marcMap.get(key)!.push({ data_hora: m.data_hora, tipo: m.tipo });
      }

      // ---------- Buscar horários das jornadas ----------
      const jornadaMap = new Map<
        number,
        Array<{
          dia_semana: number | null;
          dias_semana: number[];
          folga: boolean;
          periodos: Array<{ entrada: string; saida: string }>;
        }>
      >();

      if (jornadaIds.length > 0) {
        const horResult = await query(
          `SELECT jornada_id, dia_semana, dias_semana, folga, periodos
           FROM people.jornada_horarios
           WHERE jornada_id = ANY($1)`,
          [jornadaIds]
        );

        for (const row of horResult.rows) {
          if (!jornadaMap.has(row.jornada_id)) jornadaMap.set(row.jornada_id, []);
          const periodos =
            typeof row.periodos === 'string'
              ? JSON.parse(row.periodos)
              : row.periodos || [];
          const diasSemana =
            typeof row.dias_semana === 'string'
              ? JSON.parse(row.dias_semana)
              : row.dias_semana || [];
          jornadaMap.get(row.jornada_id)!.push({
            dia_semana: row.dia_semana,
            dias_semana: diasSemana,
            folga: row.folga,
            periodos,
          });
        }
      }

      // ---------- Buscar feriados (exatos na semana + recorrentes) ----------
      const feriadosResult = await query(
        `SELECT data::text AS data, recorrente
         FROM people.feriados
         WHERE (recorrente = false AND data BETWEEN $1::date AND $2::date)
            OR recorrente = true`,
        [dataInicio, dataFim]
      );
      const feriados = feriadosResult.rows as Array<{
        data: string;
        recorrente: boolean;
      }>;

      // ---------- Buscar parâmetros de tolerância de hora extra ----------
      const parametroHEResult = await query(
        `SELECT id, minutos_tolerancia, dias_permitidos_por_mes, ativo
         FROM people.parametros_hora_extra
         WHERE ativo = TRUE
         ORDER BY id DESC
         LIMIT 1`
      );

      const parametroHE = parametroHEResult.rows.length > 0 ? parametroHEResult.rows[0] : null;

      // Buscar histórico de tolerância do mês atual para todos os colaboradores
      const toleranciaMap = new Map<number, number>(); // colaboradorId → dias utilizados

      if (parametroHE) {
        const mesAtual = hoje.substring(0, 7);
        const primeiroDiaMes = `${mesAtual}-01`;
        const anoMes = mesAtual.split('-').map(Number);
        const ultimoDiaMes = new Date(anoMes[0], anoMes[1], 0).toISOString().split('T')[0];

        const toleranciaResult = await query(
          `SELECT colaborador_id, COUNT(*) AS dias_utilizados
           FROM people.historico_tolerancia_hora_extra
           WHERE colaborador_id = ANY($1)
             AND data BETWEEN $2::date AND $3::date
             AND consumiu_tolerancia = TRUE
           GROUP BY colaborador_id`,
          [colabIds, primeiroDiaMes, ultimoDiaMes]
        );

        for (const row of toleranciaResult.rows) {
          toleranciaMap.set(row.colaborador_id, parseInt(row.dias_utilizados));
        }
      }

      // ---------- Montar resposta ----------
      const responseData = colabResult.rows.map(colab => {
        const horarios = jornadaMap.get(colab.jornada_id) || [];

        /**
         * Retorna horas esperadas e flag de folga para um dia específico.
         * Suporta jornada simples (dia_semana) e circular (dias_semana JSONB).
         * Se o colaborador não tiver jornada cadastrada, assume 8 h em dias úteis.
         */
        function getInfoDia(dateStr: string) {
          const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=dom … 6=sab

          // Jornada simples: dia_semana === dow
          // Jornada circular: dia_semana é null, dias_semana contém o dow
          const horario = horarios.find(h =>
            h.dia_semana === dow ||
            (h.dia_semana === null && Array.isArray(h.dias_semana) && h.dias_semana.includes(dow))
          );

          if (!horario) {
            // Sem jornada: assume folga em sab/dom, 8 h nos demais
            const folgaPadrao = dow === 0 || dow === 6;
            return { horasEsperadas: folgaPadrao ? 0 : 8, isFolgaJornada: folgaPadrao };
          }

          if (horario.folga) {
            return { horasEsperadas: 0, isFolgaJornada: true };
          }

          return {
            horasEsperadas: calcularHorasEsperadas(horario.periodos),
            isFolgaJornada: false,
          };
        }

        // ---- diasSemana ----
        const diasSemana = datas.map((dateStr, idx) => {
          const { horasEsperadas, isFolgaJornada } = getInfoDia(dateStr);
          const ehFeriado = verificarFeriado(dateStr, feriados);
          const ehFolga = isFolgaJornada || ehFeriado;
          const isHoje = dateStr === hoje;
          const marcDia = marcMap.get(`${colab.id}_${dateStr}`) || [];
          const horasTrabalhadas = ehFolga
            ? 0
            : calcularHorasTrabalhadas(marcDia, agoraMs, isHoje);

          let status: string;
          if (ehFolga) {
            status = 'folga';
          } else if (dateStr > hoje) {
            status = 'futuro';
          } else if (isHoje) {
            status = 'em_andamento';
          } else {
            // Dia passado
            status =
              marcDia.length > 0 && horasTrabalhadas >= horasEsperadas
                ? 'completo'
                : 'incompleto';
          }

          return {
            dia: DIA_LABELS[idx],
            data: dateStr,
            status,
            horasTrabalhadas,
            horasEsperadas: ehFolga ? 0 : horasEsperadas,
          };
        });

        // ---- jornadaHoje ----
        const { horasEsperadas: horasEspHoje, isFolgaJornada: folgaHoje } =
          getInfoDia(hoje);
        const ehFeriadoHoje = verificarFeriado(hoje, feriados);
        const ehFolgaHoje = folgaHoje || ehFeriadoHoje;
        const marcHoje = marcMap.get(`${colab.id}_${hoje}`) || [];
        const horasTrabHoje = ehFolgaHoje
          ? 0
          : calcularHorasTrabalhadas(marcHoje, agoraMs, true);

        let statusHoje: string;
        if (ehFolgaHoje) {
          statusHoje = 'folga';
        } else if (marcHoje.length === 0) {
          statusHoje = 'nao_iniciada';
        } else {
          const lastMarc = marcHoje[marcHoje.length - 1];
          if (lastMarc.tipo === 'entrada' || lastMarc.tipo === 'retorno') {
            statusHoje = 'em_andamento';
          } else if (lastMarc.tipo === 'almoco') {
            statusHoje = 'almoco';
          } else if (horasTrabHoje >= horasEspHoje) {
            statusHoje = 'completa';
          } else {
            statusHoje = 'incompleta';
          }
        }

        const percentualHoje =
          horasEspHoje > 0
            ? Math.round((horasTrabHoje / horasEspHoje) * 10000) / 100
            : 0;

        // ---- toleranciaHoraExtra ----
        let toleranciaHoraExtra: {
          minutosTolerancia: number;
          diasPermitidosPorMes: number;
          diasUtilizados: number;
          diasRestantes: number;
        } | null = null;

        if (parametroHE) {
          const diasUtilizados = toleranciaMap.get(colab.id) || 0;
          toleranciaHoraExtra = {
            minutosTolerancia: parametroHE.minutos_tolerancia,
            diasPermitidosPorMes: parametroHE.dias_permitidos_por_mes,
            diasUtilizados,
            diasRestantes: Math.max(0, parametroHE.dias_permitidos_por_mes - diasUtilizados),
          };
        }

        return {
          colaborador: {
            id: colab.id,
            nome: colab.nome,
            cpf: colab.cpf,
            foto: colab.foto_url,
            cargo: colab.cargo_id
              ? { id: colab.cargo_id, nome: colab.cargo_nome }
              : null,
            departamento: colab.departamento_id
              ? { id: colab.departamento_id, nome: colab.departamento_nome }
              : null,
            empresa: colab.empresa_id
              ? { id: colab.empresa_id, nome: colab.empresa_nome }
              : null,
          },
          jornadaHoje: {
            horasTrabalhadas: horasTrabHoje,
            horasEsperadas: ehFolgaHoje ? 0 : horasEspHoje,
            percentual: percentualHoje,
            status: statusHoje,
          },
          diasSemana,
          toleranciaHoraExtra,
        };
      });

      return buildPaginatedResponse(responseData, total, pagina, limite);

      }, CACHE_TTL.SHORT);

      return NextResponse.json(resultado);
    } catch (error) {
      console.error('Erro ao buscar acompanhamento de jornada:', error);
      return serverErrorResponse('Erro ao buscar acompanhamento de jornada');
    }
  });
}
