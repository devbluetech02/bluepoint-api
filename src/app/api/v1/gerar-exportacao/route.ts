import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

const TIPOS_EVENTOS_VALIDOS = [
  'atraso',
  'banco_horas_negativo',
  'banco_horas_positivo',
  'faixa_extra_1',
  'faixa_extra_2',
  'falta',
  'hora_extra_domingo',
  'hora_extra_feriado',
  'hora_extra_intrajornada',
] as const;

type TipoEvento = typeof TIPOS_EVENTOS_VALIDOS[number];

const gerarExportacaoSchema = z.object({
  modeloId: z.number().int().positive('modeloId é obrigatório'),
  tipoExportacao: z.enum(['folha_normal', 'folha_complementar', 'folha_rescisao'], {
    message: 'tipoExportacao deve ser folha_normal, folha_complementar ou folha_rescisao',
  }),
  dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dataInicio deve estar no formato YYYY-MM-DD'),
  dataFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dataFim deve estar no formato YYYY-MM-DD'),
  mesReferencia: z.string().regex(/^\d{4}-\d{2}$/, 'mesReferencia deve estar no formato YYYY-MM').optional(),
  empresaId: z.number().int().positive('empresaId é obrigatório'),
  departamentoId: z.number().int().positive().optional().nullable(),
  colaboradorIds: z.array(z.number().int().positive()).optional(),
  tiposEventos: z.string().optional(),
});

// Garante largura exata: trunca se maior, pad com char se menor
function fw(value: string | number, length: number, char = '0'): string {
  const str = String(value);
  if (str.length > length) return str.substring(0, length);
  return str.padStart(length, char);
}

function inferirTipoEvento(descricao: string | null): TipoEvento | null {
  if (!descricao) return null;
  const d = descricao.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (d.includes('falta')) return 'falta';
  if (d.includes('atraso')) return 'atraso';
  if (d.includes('banco') && d.includes('negativ')) return 'banco_horas_negativo';
  if (d.includes('banco') && d.includes('positiv')) return 'banco_horas_positivo';
  if (d.includes('faixa') && d.includes('2')) return 'faixa_extra_2';
  if (d.includes('faixa') && d.includes('1')) return 'faixa_extra_1';
  if (d.includes('domingo')) return 'hora_extra_domingo';
  if (d.includes('feriado')) return 'hora_extra_feriado';
  if (d.includes('intrajornada')) return 'hora_extra_intrajornada';

  return null;
}

function formatDDMMAA(dateStr: string): string {
  const [ano, mes, dia] = dateStr.split('-');
  return `${dia}${mes}${ano.slice(2)}`;
}

function parseTiposEventos(tiposEventosStr?: string): Set<TipoEvento> | null {
  if (!tiposEventosStr) return null;
  const tipos = tiposEventosStr.split(',').map(t => t.trim()).filter(Boolean);
  const validos = new Set<TipoEvento>();
  for (const t of tipos) {
    if (TIPOS_EVENTOS_VALIDOS.includes(t as TipoEvento)) {
      validos.add(t as TipoEvento);
    }
  }
  return validos.size > 0 ? validos : null;
}

function getProcesso(tipoExportacao: string): string {
  switch (tipoExportacao) {
    case 'folha_complementar': return 'C';
    case 'folha_rescisao': return 'R';
    default: return 'F';
  }
}

// Valor Evento: 14 chars com 2 casas decimais (sem separador)
// Ex: 89 minutos → 89.00 → "00000000008900"
function formatValorEvento(valor: number): string {
  const centavos = Math.round(valor * 100);
  return fw(centavos, 14);
}

interface LinhaParams {
  sequencial: number;
  codigoEmpresa: string;
  ref1: string;         // DDMMAA
  ref2: string;         // DDMMAA
  faltasMinutos: number;
  horasTrabalhadas: number;
  diasUteis: number;
  codigoEvento: string;
  valorEvento: number;
  codigoFuncionario: number;
  processo: string;
  cnpjEmpresa: string;
  pisFuncionario: string;
  departamento: number;
}

// Layout Alterdata: 128 chars por linha
function gerarLinhaAlterdata(p: LinhaParams): string {
  const campos = [
    fw(p.sequencial, 6),                  // 1-6:   Sequencial
    fw(p.codigoEmpresa, 5),               // 7-11:  Código da Empresa
    fw(p.ref1, 6),                        // 12-17: Referência 1 (DDMMAA)
    fw(p.ref2, 6),                        // 18-23: Referência 2 (DDMMAA)
    fw(p.faltasMinutos, 6),               // 24-29: Faltas (em minutos)
    fw(p.horasTrabalhadas, 6),            // 30-35: Horas Trabalhadas
    fw(p.diasUteis, 2),                   // 36-37: Dias Úteis
    fw(p.codigoEvento, 3),                // 38-40: Código do Evento
    formatValorEvento(p.valorEvento),     // 41-54: Valor Evento (14, 2 decimais)
    fw(p.codigoFuncionario, 6),           // 55-60: Código de Funcionário
    p.processo,                           // 61:    Processo
    fw(p.cnpjEmpresa, 14),               // 62-75: CNPJ ou CPF da Empresa
    fw(p.pisFuncionario, 11),             // 76-86: PIS do Funcionário
    fw(p.departamento, 4),               // 87-90: Departamento do Funcionário
    fw('', 14),                           // 91-104: CNPJ da operadora
    fw('', 4),                            // 105-108: Código do plano
    fw('', 5),                            // 109-113: Código do beneficiário
    fw('', 11),                           // 114-124: CPF do beneficiário
    'S',                                  // 125: Forma de apuração 'Mensal'
    'N',                                  // 126: Forma de apuração 'Valor fixo'
    'N',                                  // 127: Forma de apuração 'Participativo'
    'N',                                  // 128: Forma de apuração 'Outras formas de cálculo'
  ];
  return campos.join('');
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = gerarExportacaoSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const {
        modeloId, tipoExportacao, dataInicio, dataFim,
        mesReferencia, empresaId, departamentoId, colaboradorIds, tiposEventos,
      } = validation.data;

      const filtroEventos = parseTiposEventos(tiposEventos);
      const processo = getProcesso(tipoExportacao);
      const ref1 = formatDDMMAA(dataInicio);
      const ref2 = formatDDMMAA(dataFim);

      const modeloResult = await query(
        `SELECT id, nome, ativo FROM bluepoint.bt_modelos_exportacao WHERE id = $1`,
        [modeloId]
      );

      if (modeloResult.rows.length === 0) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      if (!modeloResult.rows[0].ativo) {
        return errorResponse('Modelo de exportação está inativo');
      }

      const codigosResult = await query(
        `SELECT codigo, descricao FROM bluepoint.bt_codigos_exportacao
         WHERE modelo_id = $1 ORDER BY id`,
        [modeloId]
      );

      if (codigosResult.rows.length === 0) {
        return errorResponse('Modelo não possui códigos configurados');
      }

      const codigosModelo = codigosResult.rows
        .map(r => ({
          codigo: r.codigo as string,
          tipoEvento: inferirTipoEvento(r.descricao as string | null),
        }))
        .filter(c => c.tipoEvento !== null) as Array<{ codigo: string; tipoEvento: TipoEvento }>;

      if (codigosModelo.length === 0) {
        return errorResponse('Nenhum código do modelo pôde ser associado a um tipo de evento. Verifique as descrições dos códigos.');
      }

      const empresaResult = await query(
        `SELECT id, codigo_alterdata, cnpj FROM bluepoint.bt_empresas WHERE id = $1`,
        [empresaId]
      );
      if (empresaResult.rows.length === 0) {
        return notFoundResponse('Empresa não encontrada');
      }
      const codigoEmpresa = empresaResult.rows[0].codigo_alterdata || String(empresaId);
      const cnpjEmpresa = (empresaResult.rows[0].cnpj || '').replace(/\D/g, '');

      const colabConditions: string[] = ['c.status = $1', 'c.empresa_id = $2'];
      const colabParams: unknown[] = ['ativo', empresaId];
      let paramIdx = 3;

      if (departamentoId) {
        colabConditions.push(`c.departamento_id = $${paramIdx}`);
        colabParams.push(departamentoId);
        paramIdx++;
      }

      if (colaboradorIds && colaboradorIds.length > 0) {
        colabConditions.push(`c.id = ANY($${paramIdx})`);
        colabParams.push(colaboradorIds);
        paramIdx++;
      }

      const colaboradoresResult = await query(
        `SELECT c.id, c.nome, c.pis, c.departamento_id
         FROM bluepoint.bt_colaboradores c
         WHERE ${colabConditions.join(' AND ')}
         ORDER BY c.nome`,
        colabParams
      );

      if (colaboradoresResult.rows.length === 0) {
        return errorResponse('Nenhum colaborador encontrado para os filtros informados');
      }

      const colabIds = colaboradoresResult.rows.map(c => c.id);

      const marcacoesResult = await query(
        `SELECT m.colaborador_id, DATE(m.data_hora) as data, m.data_hora
         FROM bluepoint.bt_marcacoes m
         WHERE m.colaborador_id = ANY($1)
           AND m.data_hora >= $2
           AND m.data_hora <= $3::date + interval '1 day'
         ORDER BY m.colaborador_id, m.data_hora`,
        [colabIds, dataInicio, dataFim]
      );

      const feriadosResult = await query(
        `SELECT data FROM bluepoint.bt_feriados WHERE data >= $1 AND data <= $2`,
        [dataInicio, dataFim]
      );
      const feriadoSet = new Set(feriadosResult.rows.map(f => String(f.data).substring(0, 10)));

      const jornadasResult = await query(
        `SELECT c.id as colaborador_id, j.carga_horaria_semanal
         FROM bluepoint.bt_colaboradores c
         JOIN bluepoint.bt_jornadas j ON c.jornada_id = j.id
         WHERE c.id = ANY($1)`,
        [colabIds]
      );
      const jornadaMap = new Map<number, number>();
      for (const j of jornadasResult.rows) {
        const cargaSemanal = parseFloat(j.carga_horaria_semanal) || 44;
        jornadaMap.set(j.colaborador_id, cargaSemanal / 6);
      }

      const marcacoesPorColab = new Map<number, Array<{ data: string; data_hora: string }>>();
      for (const m of marcacoesResult.rows) {
        if (!marcacoesPorColab.has(m.colaborador_id)) {
          marcacoesPorColab.set(m.colaborador_id, []);
        }
        marcacoesPorColab.get(m.colaborador_id)!.push({
          data: m.data,
          data_hora: m.data_hora,
        });
      }

      const linhas: string[] = [];
      let sequencial = 0;

      for (const colab of colaboradoresResult.rows) {
        const marcacoes = marcacoesPorColab.get(colab.id) || [];
        const horasDiarias = jornadaMap.get(colab.id) || 8;

        const resumo = calcularResumoColaborador(marcacoes, horasDiarias, feriadoSet, dataInicio, dataFim);

        for (const cod of codigosModelo) {
          if (filtroEventos && !filtroEventos.has(cod.tipoEvento)) continue;

          const valor = resumo.eventos[cod.tipoEvento];
          if (valor <= 0) continue;

          sequencial++;
          linhas.push(gerarLinhaAlterdata({
            sequencial,
            codigoEmpresa,
            ref1,
            ref2,
            faltasMinutos: resumo.faltasMinutos,
            horasTrabalhadas: resumo.horasTrabalhadasMinutos,
            diasUteis: resumo.diasUteis,
            codigoEvento: cod.codigo,
            valorEvento: valor,
            codigoFuncionario: colab.id,
            processo,
            cnpjEmpresa,
            pisFuncionario: (colab.pis || '').replace(/\D/g, ''),
            departamento: colab.departamento_id || 0,
          }));
        }
      }

      const nomeArquivo = `exportacao_${tipoExportacao}_${dataInicio}_a_${dataFim}.txt`;
      const conteudo = linhas.join('\n');

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'EXPORT',
        modulo: 'exportacao',
        descricao: `Exportação gerada: ${nomeArquivo} (${linhas.length} linhas, ${colaboradoresResult.rows.length} colaboradores)`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        metadados: {
          modeloId, tipoExportacao, dataInicio, dataFim, mesReferencia,
          empresaId, departamentoId, totalLinhas: linhas.length,
          colaboradorIds: colaboradorIds || null,
          tiposEventos: tiposEventos || null,
        },
      });

      return successResponse({
        conteudo,
        nomeArquivo,
        totalLinhas: linhas.length,
        totalColaboradores: colaboradoresResult.rows.length,
        periodo: {
          inicio: dataInicio,
          fim: dataFim,
        },
      });
    } catch (error) {
      console.error('Erro ao gerar exportação:', error);
      return serverErrorResponse('Erro ao gerar exportação');
    }
  });
}

interface ResumoColaborador {
  faltasMinutos: number;
  horasTrabalhadasMinutos: number;
  diasUteis: number;
  eventos: Record<TipoEvento, number>;
}

function calcularResumoColaborador(
  marcacoes: Array<{ data: string; data_hora: string }>,
  horasDiarias: number,
  feriadoSet: Set<string>,
  dataInicio: string,
  dataFim: string
): ResumoColaborador {
  const eventos: Record<TipoEvento, number> = {
    atraso: 0,
    banco_horas_negativo: 0,
    banco_horas_positivo: 0,
    faixa_extra_1: 0,
    faixa_extra_2: 0,
    falta: 0,
    hora_extra_domingo: 0,
    hora_extra_feriado: 0,
    hora_extra_intrajornada: 0,
  };

  let faltasMinutos = 0;
  let horasTrabalhadasMinutos = 0;
  let diasUteis = 0;

  const marcacoesPorDia = new Map<string, string[]>();
  for (const m of marcacoes) {
    const dataStr = String(m.data).substring(0, 10);
    if (!marcacoesPorDia.has(dataStr)) {
      marcacoesPorDia.set(dataStr, []);
    }
    marcacoesPorDia.get(dataStr)!.push(m.data_hora);
  }

  const toMin = (horas: number) => Math.round(horas * 60);
  const inicio = new Date(dataInicio + 'T00:00:00');
  const fim = new Date(dataFim + 'T00:00:00');

  for (let d = new Date(inicio); d <= fim; d.setDate(d.getDate() + 1)) {
    const dataStr = d.toISOString().substring(0, 10);
    const diaSemana = d.getDay();
    const ehDomingo = diaSemana === 0;
    const ehSabado = diaSemana === 6;
    const ehFeriado = feriadoSet.has(dataStr);
    const ehDiaUtil = !ehDomingo && !ehSabado && !ehFeriado;

    const marcsDia = marcacoesPorDia.get(dataStr) || [];

    if (ehDomingo && marcsDia.length >= 2) {
      const horasTrab = calcularHorasTrabalhadas(marcsDia);
      horasTrabalhadasMinutos += toMin(horasTrab);
      eventos.hora_extra_domingo += toMin(horasTrab);
      continue;
    }

    if (ehFeriado && marcsDia.length >= 2) {
      const horasTrab = calcularHorasTrabalhadas(marcsDia);
      horasTrabalhadasMinutos += toMin(horasTrab);
      eventos.hora_extra_feriado += toMin(horasTrab);
      continue;
    }

    if (!ehDiaUtil) continue;

    diasUteis++;

    if (marcsDia.length === 0) {
      const minJornada = toMin(horasDiarias);
      eventos.falta += 1;
      faltasMinutos += minJornada;
      eventos.banco_horas_negativo += minJornada;
      continue;
    }

    if (marcsDia.length >= 2) {
      const horasTrab = calcularHorasTrabalhadas(marcsDia);
      horasTrabalhadasMinutos += toMin(horasTrab);
      const diff = horasTrab - horasDiarias;

      if (diff < 0) {
        const min = toMin(Math.abs(diff));
        eventos.atraso += min;
        eventos.banco_horas_negativo += min;
      } else if (diff > 0) {
        const min = toMin(diff);
        eventos.banco_horas_positivo += min;

        if (diff <= 2) {
          eventos.faixa_extra_1 += min;
        } else {
          eventos.faixa_extra_1 += toMin(2);
          eventos.faixa_extra_2 += toMin(diff - 2);
        }
      }

      if (marcsDia.length >= 4) {
        const intervalo = calcularIntervaloIntrajornada(marcsDia);
        if (intervalo !== null && intervalo < 60) {
          eventos.hora_extra_intrajornada += (60 - intervalo);
        }
      }
    }
  }

  return { faltasMinutos, horasTrabalhadasMinutos, diasUteis, eventos };
}

function calcularHorasTrabalhadas(marcacoes: string[]): number {
  if (marcacoes.length < 2) return 0;
  const sorted = marcacoes.map(m => new Date(m).getTime()).sort((a, b) => a - b);
  let totalMs = 0;
  for (let i = 0; i < sorted.length - 1; i += 2) {
    if (sorted[i + 1]) totalMs += sorted[i + 1] - sorted[i];
  }
  return totalMs / (1000 * 60 * 60);
}

function calcularIntervaloIntrajornada(marcacoes: string[]): number | null {
  if (marcacoes.length < 4) return null;
  const sorted = marcacoes.map(m => new Date(m).getTime()).sort((a, b) => a - b);
  return Math.round((sorted[2] - sorted[1]) / (1000 * 60));
}
