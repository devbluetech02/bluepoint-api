import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, forbiddenResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { formatCPF, formatCNPJ } from '@/lib/utils';
import { getDiasEmFeriasNoPeriodo } from '@/lib/periodos-ferias';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

// =====================================================
// TIPOS
// =====================================================

interface Periodo {
  entrada: string;
  saida: string;
}

interface JornadaHorario {
  dia_semana: number | null;
  dias_semana: number[] | null;  // JSONB [1,2,3,4,5] para jornada circular
  folga: boolean;
  periodos: Periodo[] | null;
}

interface DiaRelatorio {
  data: string;           // YYYY-MM-DD
  diaSemana: string;      // Dom, Seg, Ter...
  diaSemanaAbrev: string; // Dom, Seg, Ter...
  previsto: string;       // Ex: "07:50 12:00|13:00 17:38" ou "Folga"
  realizado: string;      // Ex: "07:50 12:34 (M)|13:04 17:38 (M)" ou "Folga" ou "Falta"
  horasTrab: string;      // Ex: "09:18" ou "00:00"
  isFolga: boolean;
  isFalta: boolean;       // Dia de trabalho sem nenhuma marcação
}

// =====================================================
// HELPERS
// =====================================================

const DIAS_SEMANA_ABREV = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function formatDateShort(dateStr: string): string {
  // Converte YYYY-MM-DD para DD/MM/YY
  const parts = dateStr.split('-');
  return `${parts[2]}/${parts[1]}/${parts[0].substring(2)}`;
}

function formatDateFull(dateStr: string): string {
  // Converte YYYY-MM-DD para DD/MM/YYYY
  const parts = dateStr.split('-');
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function getDiaSemanaFromDate(dateStr: string): number {
  // Parse YYYY-MM-DD sem timezone issues
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getDay();
}

function formatHoraMinuto(hora: string): string {
  // Extrai HH:MM de um timestamp
  if (!hora) return '';
  // Se vier como "2026-02-02 07:50:00", pegar só HH:MM
  if (hora.includes(' ')) {
    const timePart = hora.split(' ')[1];
    return timePart.substring(0, 5);
  }
  // Se já for HH:MM:SS ou HH:MM
  return hora.substring(0, 5);
}

function calcularHorasTrabalhadas(marcacoes: Array<{ data_hora: string; tipo: string }>): number {
  // Agrupar em pares entrada/saída e calcular minutos
  // 'entrada' e 'retorno' são inícios de período
  // 'saida' e 'almoco' são fins de período
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

  // Parear entradas e saídas em ordem
  const pares = Math.min(entradas.length, saidas.length);
  for (let i = 0; i < pares; i++) {
    const entrada = parseTimestamp(entradas[i]);
    const saida = parseTimestamp(saidas[i]);
    if (entrada && saida) {
      const diff = (saida.getTime() - entrada.getTime()) / (1000 * 60);
      if (diff > 0) {
        totalMinutos += diff;
      }
    }
  }

  return totalMinutos;
}

function parseTimestamp(ts: string): Date | null {
  if (!ts) return null;
  // Formato: "2026-02-02 07:50:00" ou "2026-02-02T07:50:00"
  const normalized = ts.replace('T', ' ').replace(/\.\d+/, '');
  const [datePart, timePart] = normalized.split(' ');
  if (!datePart || !timePart) return null;
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, min, s] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function minutosParaHHMM(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = Math.round(minutos % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Busca o horário da jornada correspondente a um dia da semana.
 * Suporta jornada simples (dia_semana) e circular (dias_semana JSONB).
 */
function encontrarHorarioDia(
  jornadaHorarios: JornadaHorario[],
  diaSemana: number
): JornadaHorario | undefined {
  // 1) Jornada simples: match por dia_semana
  const porDiaSemana = jornadaHorarios.find(
    h => h.dia_semana !== null && h.dia_semana !== undefined && h.dia_semana === diaSemana
  );
  if (porDiaSemana) return porDiaSemana;

  // 2) Jornada circular: match por dias_semana JSONB
  const porDiasSemana = jornadaHorarios.find(h => {
    if (!h.dias_semana || !Array.isArray(h.dias_semana)) return false;
    return h.dias_semana.includes(diaSemana);
  });
  if (porDiasSemana) return porDiasSemana;

  return undefined;
}

function construirPrevistoString(periodos: Periodo[] | null, folga: boolean): string {
  if (folga || !periodos || periodos.length === 0) return 'Folga';

  // Formata como "07:50 12:00|13:00 17:38"
  return periodos
    .map(p => `${p.entrada} ${p.saida}`)
    .join(' | ');
}

function construirRealizadoString(
  marcacoes: Array<{ data_hora: string; tipo: string }>,
  folga: boolean
): string {
  if (folga && marcacoes.length === 0) return 'Folga';
  if (marcacoes.length === 0) return '';

  // Agrupar em pares entrada/saída (entrada/retorno inicia, saida/almoco finaliza)
  const pares: Array<{ entrada?: string; saida?: string }> = [];
  let parAtual: { entrada?: string; saida?: string } = {};

  for (const m of marcacoes) {
    if (m.tipo === 'entrada' || m.tipo === 'retorno') {
      if (parAtual.entrada) {
        // Já tem entrada sem saída, salvar e criar novo par
        pares.push(parAtual);
        parAtual = {};
      }
      parAtual.entrada = formatHoraMinuto(m.data_hora);
    } else if (m.tipo === 'saida' || m.tipo === 'almoco') {
      parAtual.saida = formatHoraMinuto(m.data_hora);
      pares.push(parAtual);
      parAtual = {};
    }
  }
  if (parAtual.entrada || parAtual.saida) {
    pares.push(parAtual);
  }

  // Formatar como "07:50 12:34 (M)|13:04 17:38 (M)"
  return pares
    .map(p => {
      const parts = [];
      if (p.entrada) parts.push(p.entrada);
      if (p.saida) parts.push(p.saida);
      return parts.join(' ') + ' (M)';
    })
    .join(' | ');
}

function gerarDiasNoPeriodo(dataInicio: string, dataFim: string): string[] {
  const dias: string[] = [];
  const [sy, sm, sd] = dataInicio.split('-').map(Number);
  const [ey, em, ed] = dataFim.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);

  const current = new Date(start);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dias.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }

  return dias;
}

// =====================================================
// GERAÇÃO DO PDF
// =====================================================

function gerarPDF(dados: {
  empresa: { razaoSocial: string; cnpj: string };
  colaborador: { nome: string; cpf: string; cargo: string; dataAdmissao: string };
  periodo: { inicio: string; fim: string };
  dias: DiaRelatorio[];
  totalRegistros: number;
  geradoEm: string;
  logoPath?: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 30, bottom: 30, left: 30, right: 30 },
      info: {
        Title: `Espelho de Ponto - ${dados.colaborador.nome}`,
        Author: 'BluePoint',
        Subject: 'Relatório de Espelho de Ponto',
      },
    });

    const buffers: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.on('data', (chunk: any) => buffers.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const leftMargin = doc.page.margins.left;
    const fontNormal = 'Helvetica';
    const fontBold = 'Helvetica-Bold';
    const fontSize = 8;
    const fontSizeSmall = 7;
    const fontSizeHeader = 8.5;
    const lineHeight = 14;

    // ─── CABEÇALHO DO RELATÓRIO ───────────────────────

    let y = doc.page.margins.top;

    // Linha superior do header
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 6;

    // Logo à esquerda
    const logoWidth = 60;
    const logoHeight = 50;
    let contentStartX = leftMargin + 8;

    if (dados.logoPath && fs.existsSync(dados.logoPath)) {
      doc.image(dados.logoPath, leftMargin + 8, y, {
        fit: [logoWidth, logoHeight],
        align: 'center',
        valign: 'center',
      });
      contentStartX = leftMargin + logoWidth + 20;
    }

    // Coluna esquerda do header (após o logo)
    const col1X = contentStartX;
    const col2X = leftMargin + pageWidth * 0.52;
    const col3X = leftMargin + pageWidth * 0.82;

    // ── Coluna 1: Empresa, Colaborador, Cargo, Período
    doc.font(fontNormal).fontSize(fontSizeHeader).fillColor('#000000');
    doc.text('Empresa: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.empresa.razaoSocial.toUpperCase());

    y += lineHeight;
    doc.font(fontNormal).fontSize(fontSizeHeader);
    doc.text('Colaborador: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.colaborador.nome.toUpperCase());

    y += lineHeight;
    doc.font(fontNormal).fontSize(fontSizeHeader);
    doc.text('Cargo: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.colaborador.cargo ? dados.colaborador.cargo.toUpperCase() : '-');

    y += lineHeight;
    doc.font(fontNormal).fontSize(fontSizeHeader);
    const periodoStr = `${formatDateFull(dados.periodo.inicio)} - ${formatDateFull(dados.periodo.fim)}`;
    doc.text('Período: ', col1X, y, { continued: true });
    doc.font(fontBold).text(periodoStr);

    // ── Coluna 2: CPF/CNPJ Empresa, CPF Colaborador, Admissão
    const headerTopY = doc.page.margins.top + 6;
    doc.font(fontNormal).fontSize(fontSizeHeader).fillColor('#000000');
    doc.text('Empresa CPF/CNPJ: ', col2X, headerTopY, { continued: true });
    doc.font(fontBold).text(dados.empresa.cnpj);

    doc.font(fontNormal).fontSize(fontSizeHeader);
    doc.text('Colaborador CPF: ', col2X, headerTopY + lineHeight, { continued: true });
    doc.font(fontBold).text(dados.colaborador.cpf);

    doc.font(fontNormal).fontSize(fontSizeHeader);
    doc.text('Admissão: ', col2X, headerTopY + lineHeight * 2, { continued: true });
    doc.font(fontBold).text(dados.colaborador.dataAdmissao);

    // ── Coluna 3: Data/hora geração, Total registros
    doc.font(fontNormal).fontSize(fontSizeSmall).fillColor('#000000');
    doc.text(`Em: ${dados.geradoEm}`, col3X, headerTopY, { align: 'left', width: pageWidth - (col3X - leftMargin) });
    doc.text(`Total de registros: ${dados.totalRegistros}`, col3X, headerTopY + lineHeight);

    y += lineHeight + 6;

    // Linha inferior do header
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 2;

    // ─── TABELA ───────────────────────────────────────

    // Definir colunas
    const colData = { x: leftMargin, w: pageWidth * 0.14 };
    const colPrevisto = { x: leftMargin + pageWidth * 0.14, w: pageWidth * 0.28 };
    const colRealizado = { x: leftMargin + pageWidth * 0.42, w: pageWidth * 0.45 };
    const colHoras = { x: leftMargin + pageWidth * 0.87, w: pageWidth * 0.13 };

    // Posições X das linhas verticais (junto ao início de cada coluna)
    const colSeparators = [colPrevisto.x - 2, colRealizado.x - 2, colHoras.x - 2];

    // Helper: desenha linhas verticais separadoras entre yTop e yBottom
    function drawColumnSeparators(yTop: number, yBottom: number) {
      doc.strokeColor('#000000').lineWidth(0.3);
      for (const sx of colSeparators) {
        doc.moveTo(sx, yTop).lineTo(sx, yBottom).stroke();
      }
    }

    // Cabeçalho da tabela
    y += 4;
    const headerTextY = y;
    doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
    doc.text('Data', colData.x + 4, y, { width: colData.w });
    doc.text('Previsto', colPrevisto.x + 4, y, { width: colPrevisto.w });
    doc.text('Realizado', colRealizado.x + 4, y, { width: colRealizado.w });
    doc.text('H. trab.', colHoras.x + 4, y, { width: colHoras.w });

    y += lineHeight;

    // Linhas verticais do cabeçalho
    drawColumnSeparators(headerTextY - 4, y);

    // Linha abaixo do cabeçalho
    doc.strokeColor('#000000').lineWidth(0.3);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();

    // ─── LINHAS DE DADOS ──────────────────────────────

    let totalMinutosTrabalhados = 0;
    const rowHeight = lineHeight + 2;

    for (const dia of dados.dias) {
      // Verificar se precisa de nova página
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 100) {
        doc.addPage();
        y = doc.page.margins.top;

        // Re-desenhar cabeçalho da tabela na nova página
        const newHeaderY = y;
        doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
        doc.text('Data', colData.x + 4, y, { width: colData.w });
        doc.text('Previsto', colPrevisto.x + 4, y, { width: colPrevisto.w });
        doc.text('Realizado', colRealizado.x + 4, y, { width: colRealizado.w });
        doc.text('H. trab.', colHoras.x + 4, y, { width: colHoras.w });
        y += lineHeight;
        drawColumnSeparators(newHeaderY - 4, y);
        doc.strokeColor('#000000').lineWidth(0.3);
        doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
      }

      y += 3;
      const rowTopY = y - 3; // topo desta linha de dados

      // Data com dia da semana
      const dataFormatada = `${formatDateShort(dia.data)}  -  ${dia.diaSemanaAbrev}`;

      // Cor padrão preta para todos os textos
      doc.fillColor('#000000');

      doc.font(fontNormal).fontSize(fontSize);
      doc.text(dataFormatada, colData.x + 4, y, { width: colData.w });

      // Previsto
      if (dia.isFolga) {
        doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
        doc.text('Folga', colPrevisto.x + 4, y, { width: colPrevisto.w });
      } else {
        doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
        doc.text(dia.previsto, colPrevisto.x + 4, y, { width: colPrevisto.w });
      }

      // Realizado
      if (dia.isFolga && dia.realizado === 'Folga') {
        doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
        doc.text('Folga', colRealizado.x + 4, y, { width: colRealizado.w });
      } else if (dia.isFalta) {
        doc.font(fontBold).fontSize(fontSize).fillColor('#cc0000');
        doc.text('Falta', colRealizado.x + 4, y, { width: colRealizado.w });
      } else {
        doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
        doc.text(dia.realizado, colRealizado.x + 4, y, { width: colRealizado.w });
      }

      // Horas trabalhadas
      doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
      doc.text(dia.horasTrab, colHoras.x + 4, y, { width: colHoras.w });

      y += rowHeight - 3;

      // Linhas verticais separadoras desta linha
      drawColumnSeparators(rowTopY, y);

      // Linha de separação horizontal
      doc.strokeColor('#000000').lineWidth(0.2);
      doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();

      // Somar total
      const [h, m] = dia.horasTrab.split(':').map(Number);
      totalMinutosTrabalhados += (h || 0) * 60 + (m || 0);
    }

    // ─── LINHA DE TOTAL ───────────────────────────────

    y += 2;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 4;

    const totalStr = minutosParaHHMM(totalMinutosTrabalhados);
    doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
    doc.text(totalStr, colHoras.x + 4, y, { width: colHoras.w });

    y += lineHeight + 6;

    // ─── LEGENDA ──────────────────────────────────────

    doc.strokeColor('#000000').lineWidth(0.3);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 6;

    doc.font(fontBold).fontSize(fontSizeSmall).fillColor('#000000');
    doc.text('Legenda:', leftMargin + 4, y, { continued: true });
    doc.font(fontNormal).fontSize(fontSizeSmall);
    doc.text(
      '   (M) Marcação   (A) Ajuste Manual   (AB) Abono Parcial   (AT) Atestado Parcial   (HE) Horas extras   (BH) Banco de horas   (JH) Jornada híbrida'
    );

    y = doc.y + 20;

    // ─── ÁREA DE ASSINATURAS ──────────────────────────

    // Verificar se cabe na página
    if (y + 80 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top + 40;
    }

    const assinaturaWidth = pageWidth * 0.45;
    const assinaturaY = y + 30;

    // Linha de assinatura do colaborador
    const assColabX = leftMargin + (pageWidth / 2 - assinaturaWidth) / 2;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(assColabX, assinaturaY).lineTo(assColabX + assinaturaWidth, assinaturaY).stroke();

    doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
    doc.text(
      dados.colaborador.nome.toUpperCase(),
      assColabX,
      assinaturaY + 6,
      { width: assinaturaWidth, align: 'center' }
    );

    // Linha de assinatura da empresa
    const assEmpresaX = leftMargin + pageWidth / 2 + (pageWidth / 2 - assinaturaWidth) / 2;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(assEmpresaX, assinaturaY).lineTo(assEmpresaX + assinaturaWidth, assinaturaY).stroke();

    doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
    doc.text(
      dados.empresa.razaoSocial.toUpperCase(),
      assEmpresaX,
      assinaturaY + 6,
      { width: assinaturaWidth, align: 'center' }
    );

    // ─── FINALIZAR ────────────────────────────────────

    doc.end();
  });
}

// =====================================================
// ENDPOINT
// =====================================================

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const colaboradorId = searchParams.get('colaboradorId');
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');

      // Validação
      if (!colaboradorId) {
        return errorResponse('O parâmetro colaboradorId é obrigatório', 400);
      }

      if (!dataInicio || !dataFim) {
        return errorResponse('Os parâmetros dataInicio e dataFim são obrigatórios', 400);
      }

      // Validar formato das datas (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(dataInicio) || !dateRegex.test(dataFim)) {
        return errorResponse('As datas devem estar no formato YYYY-MM-DD', 400);
      }

      // Espelho de ponto contém histórico completo do colaborador —
      // só próprio + admin + gestor com escopo podem gerar.
      const colaboradorIdNum = parseInt(colaboradorId, 10);
      if (Number.isNaN(colaboradorIdNum)) {
        return errorResponse('colaboradorId inválido', 400);
      }
      const acesso = await asseguraAcessoColaborador(user, colaboradorIdNum);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      // ─── Buscar dados do colaborador ────────────────

      const colaboradorResult = await query(
        `SELECT 
          c.id, c.nome, c.cpf, c.cargo_id, cg.nome as cargo_nome, c.data_admissao, c.empresa_id, c.jornada_id,
          e.razao_social AS empresa_razao_social,
          e.cnpj AS empresa_cnpj
        FROM people.colaboradores c
        LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
        LEFT JOIN people.empresas e ON c.empresa_id = e.id
        WHERE c.id = $1`,
        [parseInt(colaboradorId)]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      const colab = colaboradorResult.rows[0];

      // ─── Buscar horários da jornada ─────────────────

      let jornadaHorarios: JornadaHorario[] = [];
      if (colab.jornada_id) {
        const jornadaResult = await query(
          `SELECT dia_semana, dias_semana, folga, periodos
           FROM people.jornada_horarios
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

      // ─── Buscar marcações do período ────────────────

      const marcacoesResult = await query(
        `SELECT data_hora, tipo
         FROM people.marcacoes
         WHERE colaborador_id = $1
           AND data_hora >= $2
           AND data_hora < ($3::date + interval '1 day')
         ORDER BY data_hora`,
        [parseInt(colaboradorId), dataInicio, dataFim]
      );

      // Agrupar marcações por dia
      const marcacoesPorDia = new Map<string, Array<{ data_hora: string; tipo: string }>>();
      for (const m of marcacoesResult.rows) {
        // Extrair a data (YYYY-MM-DD) do timestamp
        const dataStr = String(m.data_hora).substring(0, 10);
        if (!marcacoesPorDia.has(dataStr)) {
          marcacoesPorDia.set(dataStr, []);
        }
        marcacoesPorDia.get(dataStr)!.push({
          data_hora: String(m.data_hora),
          tipo: m.tipo,
        });
      }

      // ─── Construir dados de cada dia ────────────────

      const diasPeriodo = gerarDiasNoPeriodo(dataInicio, dataFim);
      const feriasPorDia = await getDiasEmFeriasNoPeriodo(parseInt(colaboradorId), dataInicio, dataFim);
      const diasRelatorio: DiaRelatorio[] = [];
      let totalRegistros = 0;

      for (const diaStr of diasPeriodo) {
        const diaSemana = getDiaSemanaFromDate(diaStr);
        const diaSemanaAbrev = DIAS_SEMANA_ABREV[diaSemana];

        // Buscar horário previsto para esse dia da semana (suporta simples e circular)
        const horarioDia = encontrarHorarioDia(jornadaHorarios, diaSemana);

        // Folga é APENAS quando encontrou o horário e ele está explicitamente marcado como folga
        const isFolga = horarioDia ? horarioDia.folga : false;
        const periodos = horarioDia?.periodos || null;

        // Se não encontrou horário nenhum E a jornada existe, tratar como dia sem escala
        // (não é folga, é um dia onde o colaborador deveria ter horário definido)
        const temEscala = !!horarioDia && !isFolga;

        // Marcações do dia
        const marcacoesDia = marcacoesPorDia.get(diaStr) || [];
        totalRegistros += marcacoesDia.length;

        // Dia em férias aprovadas: não gera falta
        const isFerias = feriasPorDia.has(diaStr);
        // Falta: dia com escala de trabalho (não é folga) mas sem nenhuma marcação e não é férias
        const isFalta = !isFolga && temEscala && marcacoesDia.length === 0 && !isFerias;

        // Calcular horas trabalhadas
        const minutosTrab = calcularHorasTrabalhadas(marcacoesDia);
        const horasTrab = minutosParaHHMM(minutosTrab);

        // Construir string do realizado
        let realizado: string;
        if (isFolga && marcacoesDia.length === 0) {
          realizado = 'Folga';
        } else if (isFerias && marcacoesDia.length === 0) {
          realizado = 'Férias';
        } else if (isFalta) {
          realizado = 'Falta';
        } else {
          realizado = construirRealizadoString(marcacoesDia, false);
        }

        diasRelatorio.push({
          data: diaStr,
          diaSemana: DIAS_SEMANA_ABREV[diaSemana],
          diaSemanaAbrev,
          previsto: construirPrevistoString(periodos, isFolga),
          realizado,
          horasTrab,
          isFolga,
          isFalta,
        });
      }

      // ─── Formatar dados do header ───────────────────

      // Formatar CPF do colaborador
      const cpfFormatado = colab.cpf ? formatCPF(colab.cpf) : '-';

      // Formatar CNPJ da empresa
      const cnpjFormatado = colab.empresa_cnpj ? formatCNPJ(colab.empresa_cnpj) : '-';

      // Formatar data de admissão
      const admissaoFormatada = colab.data_admissao
        ? formatDateFull(String(colab.data_admissao).substring(0, 10))
        : '-';

      // Data/hora de geração
      const agora = new Date();
      const geradoEm = agora.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }) + ' (-03:00)';

      // ─── Gerar PDF ─────────────────────────────────

      // Resolver caminho do logo
      const logoPath = path.join(process.cwd(), 'public', 'images', 'logo.png');

      const pdfBuffer = await gerarPDF({
        empresa: {
          razaoSocial: colab.empresa_razao_social || 'Empresa não informada',
          cnpj: cnpjFormatado,
        },
        colaborador: {
          nome: colab.nome,
          cpf: cpfFormatado,
          cargo: colab.cargo_nome || '-',
          dataAdmissao: admissaoFormatada,
        },
        periodo: {
          inicio: dataInicio,
          fim: dataFim,
        },
        dias: diasRelatorio,
        totalRegistros,
        geradoEm,
        logoPath,
      });

      // ─── Retornar PDF ──────────────────────────────

      const nomeArquivo = `espelho-ponto-${colab.nome.replace(/\s+/g, '-').toLowerCase()}-${dataInicio}-${dataFim}.pdf`;

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'exportar',
        modulo: 'relatorios',
        descricao: `Espelho de ponto PDF: ${colab.nome} (${dataInicio} a ${dataFim})`,
        colaboradorId: parseInt(colaboradorId),
        colaboradorNome: colab.nome,
      }));

      return new Response(pdfBuffer as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${nomeArquivo}"`,
          'Content-Length': String(pdfBuffer.length),
        },
      });
    } catch (error) {
      console.error('Erro ao gerar espelho de ponto PDF:', error);
      return serverErrorResponse('Erro ao gerar relatório PDF');
    }
  });
}
