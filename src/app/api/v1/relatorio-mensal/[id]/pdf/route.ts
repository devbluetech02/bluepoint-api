import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { formatCPF, formatCNPJ } from '@/lib/utils';
import { getDiasEmFeriasNoPeriodo } from '@/lib/periodos-ferias';
import { uploadArquivo } from '@/lib/storage';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

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

interface DiaPDF {
  data: string;
  diaSemana: string;
  previsto: string;
  realizado: string;
  horasTrab: string;
  horasExtras: string;
  saldo: string;
  isFolga: boolean;
  isFalta: boolean;
  isFeriado?: boolean;
  nomeFeriado?: string;
  isFuturo?: boolean;
  interjornada?: string;
  intraJornada?: string;
  horasDiurnas?: string;
  horasNoturnas?: string;
  heDiurnas?: string;
  heNoturnas?: string;
  heTotais?: string;
  atrasoStr?: string;
}

const DIAS_SEMANA_ABREV = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function encontrarHorarioDia(jornadaHorarios: JornadaHorario[], diaSemana: number): JornadaHorario | undefined {
  return jornadaHorarios.find(h => h.dia_semana !== null && h.dia_semana === diaSemana)
    || jornadaHorarios.find(h => h.dias_semana?.includes(diaSemana));
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
  if (hora.includes(' ')) return hora.split(' ')[1].substring(0, 5);
  return hora.substring(0, 5);
}

function minutosParaHHMM(minutos: number): string {
  const h = Math.floor(Math.abs(minutos) / 60);
  const m = Math.round(Math.abs(minutos) % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minutosParaSaldo(minutos: number): string {
  return `${minutos >= 0 ? '+' : '-'}${minutosParaHHMM(minutos)}`;
}

function calcularMinutosTrabalhados(marcacoes: Array<{ data_hora: string; tipo: string }>): number {
  let total = 0;
  const entradas = marcacoes.filter(m => m.tipo === 'entrada' || m.tipo === 'retorno').map(m => m.data_hora);
  const saidas = marcacoes.filter(m => m.tipo === 'saida' || m.tipo === 'almoco').map(m => m.data_hora);
  for (let i = 0; i < Math.min(entradas.length, saidas.length); i++) {
    const e = parseTimestamp(entradas[i]);
    const s = parseTimestamp(saidas[i]);
    if (e && s) {
      const diff = (s.getTime() - e.getTime()) / 60000;
      if (diff > 0) total += diff;
    }
  }
  return total;
}

function calcularCargaPrevista(periodos: Periodo[] | null): number {
  if (!periodos) return 0;
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
    dias.push(`${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return dias;
}

function getDiaSemanaFromDate(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function formatDateShort(dateStr: string): string {
  const parts = dateStr.split('-');
  return `${parts[2]}/${parts[1]}`;
}

function construirPrevistoString(periodos: Periodo[] | null, folga: boolean): string {
  if (folga || !periodos || periodos.length === 0) return 'Folga';
  return periodos.map(p => `${p.entrada} ${p.saida}`).join(' | ');
}

function construirRealizadoString(marcacoes: Array<{ data_hora: string; tipo: string }>): string {
  if (marcacoes.length === 0) return '';
  const pares: Array<{ entrada?: string; saida?: string }> = [];
  let atual: { entrada?: string; saida?: string } = {};

  for (const m of marcacoes) {
    if (m.tipo === 'entrada' || m.tipo === 'retorno') {
      if (atual.entrada) { pares.push(atual); atual = {}; }
      atual.entrada = formatHoraMinuto(m.data_hora);
    } else if (m.tipo === 'saida' || m.tipo === 'almoco') {
      atual.saida = formatHoraMinuto(m.data_hora);
      pares.push(atual);
      atual = {};
    }
  }
  if (atual.entrada || atual.saida) pares.push(atual);

  return pares.map(p => {
    const parts = [];
    if (p.entrada) parts.push(p.entrada);
    if (p.saida) parts.push(p.saida);
    return parts.join(' ');
  }).join(' | ');
}

type ModeloPDF = 'padrao' | 'completo' | 'faixas_he' | 'personalizado';

const MODELOS_DISPONIVEIS: { id: ModeloPDF; nome: string; descricao: string }[] = [
  { id: 'padrao', nome: 'Padrão', descricao: 'Relatório com previsto, realizado, horas extras, saldo e assinatura' },
  { id: 'completo', nome: 'Completo', descricao: 'Relatório detalhado com interjornada, horas diurnas/noturnas, HE separadas, atrasos e resumos completos' },
  { id: 'faixas_he', nome: 'Faixas de HE', descricao: 'Relatório detalhado com 13 colunas, faixas de horas extras e assinaturas' },
  { id: 'personalizado', nome: 'Personalizado', descricao: 'Relatório com colunas personalizáveis pelo usuário' },
];

// ─── COLUNAS PERSONALIZÁVEIS ─────────────────────────

interface ColunaPersonalizado {
  id: string;
  nome: string;
  larguraBase: number;
  obrigatoria: boolean;
  align: 'left' | 'center';
}

const COLUNAS_PERSONALIZADO_DEFS: ColunaPersonalizado[] = [
  { id: 'data', nome: 'Data', larguraBase: 0.10, obrigatoria: true, align: 'left' },
  { id: 'previsto', nome: 'Previsto', larguraBase: 0.18, obrigatoria: false, align: 'left' },
  { id: 'interjornada', nome: 'Inter-jornada', larguraBase: 0.05, obrigatoria: false, align: 'center' },
  { id: 'realizado', nome: 'Realizado', larguraBase: 0.22, obrigatoria: false, align: 'left' },
  { id: 'intrajornada', nome: 'Intra-jornada', larguraBase: 0.05, obrigatoria: false, align: 'center' },
  { id: 'h_diurnas', nome: 'H. diurnas', larguraBase: 0.055, obrigatoria: false, align: 'center' },
  { id: 'h_noturnas', nome: 'H. noturnas', larguraBase: 0.055, obrigatoria: false, align: 'center' },
  { id: 'h_totais', nome: 'H. totais', larguraBase: 0.055, obrigatoria: false, align: 'center' },
  { id: 'he_diurnas', nome: 'HE diurnas', larguraBase: 0.055, obrigatoria: false, align: 'center' },
  { id: 'he_noturnas', nome: 'HE noturnas', larguraBase: 0.055, obrigatoria: false, align: 'center' },
  { id: 'he_totais', nome: 'HE totais', larguraBase: 0.055, obrigatoria: false, align: 'center' },
  { id: 'h_trab', nome: 'H. trab.', larguraBase: 0.065, obrigatoria: false, align: 'center' },
  { id: 'h_extras', nome: 'H. Extra', larguraBase: 0.065, obrigatoria: false, align: 'center' },
  { id: 'saldo', nome: 'Saldo', larguraBase: 0.065, obrigatoria: false, align: 'center' },
  { id: 'atraso', nome: 'Atraso', larguraBase: 0.065, obrigatoria: false, align: 'center' },
  { id: 'obs', nome: 'Obs', larguraBase: 0.06, obrigatoria: false, align: 'left' },
];

const COLUNAS_PADRAO_DEFAULT = ['data', 'previsto', 'realizado', 'h_trab', 'h_extras', 'saldo', 'obs'];

function getValorColuna(colId: string, dia: DiaPDF): { texto: string; cor?: string; negrito?: boolean } {
  switch (colId) {
    case 'data': return { texto: `${formatDateShort(dia.data)} ${dia.diaSemana}` };
    case 'previsto':
      if (dia.isFeriado) return { texto: 'Feriado', negrito: true, cor: '#CC8800' };
      if (dia.isFuturo && !dia.realizado) return { texto: dia.previsto };
      if (dia.isFolga) return { texto: 'Folga', negrito: true };
      return { texto: dia.previsto };
    case 'interjornada': return { texto: dia.interjornada || '' };
    case 'realizado':
      if (dia.isFeriado && !dia.realizado) return { texto: 'Feriado', negrito: true, cor: '#CC8800' };
      if (dia.isFuturo && !dia.realizado) return { texto: '' };
      if (dia.isFolga && !dia.isFeriado) return { texto: dia.realizado || 'Folga', negrito: true };
      if (dia.isFalta) return { texto: 'Falta', cor: '#cc0000', negrito: true };
      return { texto: dia.realizado };
    case 'intrajornada': return { texto: dia.intraJornada || '' };
    case 'h_diurnas': return { texto: dia.horasDiurnas || '00:00' };
    case 'h_noturnas': return { texto: dia.horasNoturnas || '00:00' };
    case 'h_totais': return { texto: dia.horasTrab };
    case 'he_diurnas': return { texto: dia.heDiurnas || '00:00' };
    case 'he_noturnas': return { texto: dia.heNoturnas || '00:00' };
    case 'he_totais': return { texto: dia.heTotais || '00:00' };
    case 'h_trab': return { texto: dia.horasTrab };
    case 'h_extras': return { texto: dia.horasExtras };
    case 'saldo': {
      const cor = dia.saldo.startsWith('-') ? '#cc0000' : '#006600';
      return { texto: dia.saldo, cor };
    }
    case 'atraso': {
      const val = dia.atrasoStr || '00:00';
      return { texto: val, cor: val !== '00:00' ? '#cc0000' : undefined };
    }
    case 'obs': return { texto: '' };
    default: return { texto: '' };
  }
}

function getTotalColuna(colId: string, dados: DadosRelatorio): string | null {
  const ext = dados.totaisExtendidos;
  switch (colId) {
    case 'h_diurnas': return ext?.totalHorasDiurnas || dados.totais.horasTrabalhadas;
    case 'h_noturnas': return ext?.totalHorasNoturnas || '00:00';
    case 'h_totais': return dados.totais.horasTrabalhadas;
    case 'he_diurnas': return ext?.totalHeDiurnas || dados.totais.horasExtras;
    case 'he_noturnas': return ext?.totalHeNoturnas || '00:00';
    case 'he_totais': return ext?.totalHeTotais || dados.totais.horasExtras;
    case 'h_trab': return dados.totais.horasTrabalhadas;
    case 'h_extras': return dados.totais.horasExtras;
    case 'saldo': return dados.totais.bancoHoras;
    case 'atraso': return ext?.totalAtrasoStr || '00:00';
    default: return null;
  }
}

interface DadosAssinatura {
  assinadoEm: string;
  colaboradorNome: string;
  colaboradorId: number;
  dispositivo: string | null;
  localizacaoGps: string | null;
  ipAddress: string | null;
  assinaturaImagem: string | null;
}

interface DadosRelatorio {
  empresa: { razaoSocial: string; cnpj: string };
  colaborador: { nome: string; cpf: string; cargo: string; dataAdmissao: string };
  mesAno: string;
  dias: DiaPDF[];
  totais: {
    diasTrabalhados: number;
    horasTrabalhadas: string;
    horasExtras: string;
    bancoHoras: string;
    faltas: number;
    atrasos: number;
  };
  logoPath?: string;
  assinatura?: DadosAssinatura | null;
  totaisExtendidos?: {
    totalHorasDiurnas: string;
    totalHorasNoturnas: string;
    totalHeDiurnas: string;
    totalHeNoturnas: string;
    totalHeTotais: string;
    totalAtrasoStr: string;
    folgas: number;
    totalRegistros: number;
    geradoEm: string;
    periodo: string;
  };
  colunasPersonalizadas?: string[];
}

const geradores: Record<ModeloPDF, (dados: DadosRelatorio) => Promise<Buffer>> = {
  padrao: gerarPDFPadrao,
  completo: gerarPDFCompleto,
  faixas_he: gerarPDFFaixasHE,
  personalizado: gerarPDFPersonalizado,
};

function gerarPDFPadrao(dados: {
  empresa: { razaoSocial: string; cnpj: string };
  colaborador: { nome: string; cpf: string; cargo: string; dataAdmissao: string };
  mesAno: string;
  dias: DiaPDF[];
  totais: {
    diasTrabalhados: number;
    horasTrabalhadas: string;
    horasExtras: string;
    bancoHoras: string;
    faltas: number;
    atrasos: number;
  };
  logoPath?: string;
  assinatura?: DadosAssinatura | null;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 30, bottom: 30, left: 30, right: 30 },
      info: {
        Title: `Relatório Mensal - ${dados.colaborador.nome} - ${dados.mesAno}`,
        Author: 'BluePoint',
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
    const fontSize = 7;
    const lineHeight = 10;

    let y = doc.page.margins.top;

    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 4;

    let contentStartX = leftMargin + 8;
    if (dados.logoPath && fs.existsSync(dados.logoPath)) {
      doc.image(dados.logoPath, leftMargin + 8, y, { fit: [60, 50], align: 'center', valign: 'center' });
      contentStartX = leftMargin + 80;
    }

    const col1X = contentStartX;
    const col2X = leftMargin + pageWidth * 0.55;

    doc.font(fontNormal).fontSize(7.5).fillColor('#000000');
    doc.text('Empresa: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.empresa.razaoSocial.toUpperCase());
    y += lineHeight;
    doc.font(fontNormal).fontSize(7.5);
    doc.text('Colaborador: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.colaborador.nome.toUpperCase());
    y += lineHeight;
    doc.font(fontNormal).fontSize(7.5);
    doc.text('Cargo: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.colaborador.cargo || '-');
    y += lineHeight;
    doc.font(fontNormal).fontSize(7.5);
    doc.text('Período: ', col1X, y, { continued: true });
    doc.font(fontBold).text(dados.mesAno);

    const headerTopY = doc.page.margins.top + 4;
    doc.font(fontNormal).fontSize(7.5).fillColor('#000000');
    doc.text(`CNPJ: ${dados.empresa.cnpj}`, col2X, headerTopY);
    doc.text(`CPF: ${dados.colaborador.cpf}`, col2X, headerTopY + lineHeight);
    doc.text(`Admissão: ${dados.colaborador.dataAdmissao}`, col2X, headerTopY + lineHeight * 2);

    y += lineHeight + 4;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 3;

    const cols = {
      data: { x: leftMargin, w: pageWidth * 0.10 },
      previsto: { x: leftMargin + pageWidth * 0.10, w: pageWidth * 0.22 },
      realizado: { x: leftMargin + pageWidth * 0.32, w: pageWidth * 0.28 },
      horasTrab: { x: leftMargin + pageWidth * 0.60, w: pageWidth * 0.10 },
      horasExtras: { x: leftMargin + pageWidth * 0.70, w: pageWidth * 0.10 },
      saldo: { x: leftMargin + pageWidth * 0.80, w: pageWidth * 0.10 },
      obs: { x: leftMargin + pageWidth * 0.90, w: pageWidth * 0.10 },
    };

    doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
    doc.text('Data', cols.data.x + 2, y, { width: cols.data.w });
    doc.text('Previsto', cols.previsto.x + 2, y, { width: cols.previsto.w });
    doc.text('Realizado', cols.realizado.x + 2, y, { width: cols.realizado.w });
    doc.text('H. Trab.', cols.horasTrab.x + 2, y, { width: cols.horasTrab.w });
    doc.text('H. Extra', cols.horasExtras.x + 2, y, { width: cols.horasExtras.w });
    doc.text('Saldo', cols.saldo.x + 2, y, { width: cols.saldo.w });
    doc.text('Obs', cols.obs.x + 2, y, { width: cols.obs.w });

    y += lineHeight;
    doc.strokeColor('#000000').lineWidth(0.3);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();

    const rowHeight = lineHeight;

    function drawTableHeader() {
      doc.font(fontBold).fontSize(fontSize).fillColor('#000000');
      doc.text('Data', cols.data.x + 2, y, { width: cols.data.w });
      doc.text('Previsto', cols.previsto.x + 2, y, { width: cols.previsto.w });
      doc.text('Realizado', cols.realizado.x + 2, y, { width: cols.realizado.w });
      doc.text('H. Trab.', cols.horasTrab.x + 2, y, { width: cols.horasTrab.w });
      doc.text('H. Extra', cols.horasExtras.x + 2, y, { width: cols.horasExtras.w });
      doc.text('Saldo', cols.saldo.x + 2, y, { width: cols.saldo.w });
      doc.text('Obs', cols.obs.x + 2, y, { width: cols.obs.w });
      y += lineHeight;
      doc.strokeColor('#000000').lineWidth(0.3);
      doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    }

    for (const dia of dados.dias) {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 90) {
        doc.addPage();
        y = doc.page.margins.top;
        drawTableHeader();
      }

      y += 2;
      const dataFormatada = `${formatDateShort(dia.data)} ${dia.diaSemana}`;

      doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
      doc.text(dataFormatada, cols.data.x + 2, y, { width: cols.data.w });

      if (dia.isFeriado && !dia.realizado) {
        doc.font(fontBold).fillColor('#CC8800').text('Feriado', cols.previsto.x + 2, y, { width: cols.previsto.w });
        doc.text('Feriado', cols.realizado.x + 2, y, { width: cols.realizado.w });
        doc.fillColor('#000000');
      } else if (dia.isFuturo && !dia.realizado) {
        doc.font(fontNormal).text(dia.previsto, cols.previsto.x + 2, y, { width: cols.previsto.w });
        doc.text('', cols.realizado.x + 2, y, { width: cols.realizado.w });
      } else if (dia.isFolga) {
        doc.font(fontBold).text('Folga', cols.previsto.x + 2, y, { width: cols.previsto.w });
        doc.text(dia.realizado || 'Folga', cols.realizado.x + 2, y, { width: cols.realizado.w });
      } else if (dia.isFalta) {
        doc.font(fontNormal).text(dia.previsto, cols.previsto.x + 2, y, { width: cols.previsto.w });
        doc.font(fontBold).fillColor('#cc0000').text('Falta', cols.realizado.x + 2, y, { width: cols.realizado.w });
        doc.fillColor('#000000');
      } else {
        doc.font(fontNormal).text(dia.previsto, cols.previsto.x + 2, y, { width: cols.previsto.w });
        doc.text(dia.realizado, cols.realizado.x + 2, y, { width: cols.realizado.w });
      }

      doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
      doc.text(dia.horasTrab, cols.horasTrab.x + 2, y, { width: cols.horasTrab.w });
      doc.text(dia.horasExtras, cols.horasExtras.x + 2, y, { width: cols.horasExtras.w });

      const saldoColor = (dia.isFeriado || dia.isFuturo) ? '#000000' : dia.saldo.startsWith('-') ? '#cc0000' : '#006600';
      doc.fillColor(saldoColor).text(dia.saldo, cols.saldo.x + 2, y, { width: cols.saldo.w });
      doc.fillColor('#000000');

      y += rowHeight - 2;
      doc.strokeColor('#000000').lineWidth(0.2);
      doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    }

    y += 3;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    y += 4;

    doc.font(fontBold).fontSize(7).fillColor('#000000');
    doc.text(`Dias Trabalhados: ${dados.totais.diasTrabalhados}`, leftMargin + 4, y);
    doc.text(`Horas Trabalhadas: ${dados.totais.horasTrabalhadas}`, leftMargin + pageWidth * 0.2, y);
    doc.text(`Horas Extras: ${dados.totais.horasExtras}`, leftMargin + pageWidth * 0.4, y);
    doc.text(`Banco de Horas: ${dados.totais.bancoHoras}`, leftMargin + pageWidth * 0.6, y);
    doc.text(`Faltas: ${dados.totais.faltas}`, leftMargin + pageWidth * 0.8, y);
    y += lineHeight;
    doc.text(`Atrasos: ${dados.totais.atrasos}`, leftMargin + 4, y);

    y += lineHeight + 4;

    const assinaturaDigital = dados.assinatura;

    if (assinaturaDigital) {
      const blocoHeight = assinaturaDigital.assinaturaImagem ? 130 : 75;
      if (y + blocoHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top + 10;
      }

      doc.strokeColor('#333333').lineWidth(0.5);
      doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
      y += 6;

      if (assinaturaDigital.assinaturaImagem) {
        try {
          const imgBuffer = Buffer.from(assinaturaDigital.assinaturaImagem, 'base64');
          doc.image(imgBuffer, leftMargin + (pageWidth - 140) / 2, y, { width: 140, height: 50 });
          y += 55;
        } catch {
          y += 4;
        }
      }

      const lineX = leftMargin + (pageWidth - 300) / 2;
      doc.strokeColor('#000000').lineWidth(0.5);
      doc.moveTo(lineX, y).lineTo(lineX + 300, y).stroke();
      y += 6;

      const fontSizeAss = 7;
      doc.font(fontBold).fontSize(fontSizeAss).fillColor('#000000');
      doc.text(
        `Assinado digitalmente por: ${assinaturaDigital.colaboradorNome} (#${assinaturaDigital.colaboradorId})`,
        leftMargin, y, { width: pageWidth, align: 'center' }
      );
      y += lineHeight;

      doc.font(fontNormal).fontSize(fontSizeAss);
      const dataFormatada = (() => {
        try {
          const d = new Date(assinaturaDigital.assinadoEm);
          return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        } catch { return assinaturaDigital.assinadoEm; }
      })();
      doc.text(
        `Em: ${dataFormatada}${assinaturaDigital.dispositivo ? ` | Dispositivo: ${assinaturaDigital.dispositivo}` : ''}`,
        leftMargin, y, { width: pageWidth, align: 'center' }
      );
      y += lineHeight;

      const detalhes: string[] = [];
      if (assinaturaDigital.localizacaoGps) detalhes.push(`GPS: ${assinaturaDigital.localizacaoGps}`);
      if (assinaturaDigital.ipAddress) detalhes.push(`IP: ${assinaturaDigital.ipAddress}`);
      if (detalhes.length > 0) {
        doc.text(detalhes.join(' | '), leftMargin, y, { width: pageWidth, align: 'center' });
        y += lineHeight;
      }

      y += 4;
      doc.font(fontNormal).fontSize(6).fillColor('#444444');
      doc.text(
        'Declaro que concordo com os registros de ponto apresentados.',
        leftMargin, y, { width: pageWidth, align: 'center' }
      );
      y += 8;
      doc.fontSize(5.5).fillColor('#666666');
      doc.text(
        'Validade jurídica: MP 2.200-2/2001, Art. 10, §2º',
        leftMargin, y, { width: pageWidth, align: 'center' }
      );
      y += lineHeight;

      doc.strokeColor('#333333').lineWidth(0.5);
      doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).stroke();
    } else {
      if (y + 45 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top + 20;
      }

      const assWidth = pageWidth * 0.4;
      const assY = y + 15;
      const assColabX = leftMargin + (pageWidth / 2 - assWidth) / 2;
      doc.strokeColor('#000000').lineWidth(0.5);
      doc.moveTo(assColabX, assY).lineTo(assColabX + assWidth, assY).stroke();
      doc.font(fontNormal).fontSize(fontSize).fillColor('#000000');
      doc.text(dados.colaborador.nome.toUpperCase(), assColabX, assY + 6, { width: assWidth, align: 'center' });

      const assEmpX = leftMargin + pageWidth / 2 + (pageWidth / 2 - assWidth) / 2;
      doc.moveTo(assEmpX, assY).lineTo(assEmpX + assWidth, assY).stroke();
      doc.text(dados.empresa.razaoSocial.toUpperCase(), assEmpX, assY + 6, { width: assWidth, align: 'center' });
    }

    doc.end();
  });
}

function gerarPDFCompleto(dados: DadosRelatorio): Promise<Buffer> {
  return _gerarPDFDetalhado(dados, 'completo');
}

function gerarPDFFaixasHE(dados: DadosRelatorio): Promise<Buffer> {
  return _gerarPDFDetalhado(dados, 'faixas_he');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _gerarPDFDetalhado(dados: DadosRelatorio, footerMode: 'completo' | 'faixas_he'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 22, bottom: 18, left: 22, right: 22 },
      info: {
        Title: `Relatório Completo - ${dados.colaborador.nome} - ${dados.mesAno}`,
        Author: 'BluePoint',
      },
    });

    const buffers: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.on('data', (chunk: any) => buffers.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const lm = doc.page.margins.left;
    const fN = 'Helvetica';
    const fB = 'Helvetica-Bold';
    const lh = 9;

    let y = doc.page.margins.top;

    // ─── HEADER ─────────────────────────────────────────
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    y += 3;

    let csx = lm + 5;
    if (dados.logoPath && fs.existsSync(dados.logoPath)) {
      doc.image(dados.logoPath, lm + 5, y, { fit: [50, 38], align: 'center', valign: 'center' });
      csx = lm + 60;
    }

    const c2x = lm + pageW * 0.50;
    const c3x = lm + pageW * 0.80;

    doc.font(fN).fontSize(6).fillColor('#000000');
    doc.text('Empresa: ', csx, y, { continued: true }); doc.font(fB).text(dados.empresa.razaoSocial.toUpperCase());
    y += lh;
    doc.font(fN).fontSize(6);
    doc.text('Colaborador: ', csx, y, { continued: true }); doc.font(fB).text(dados.colaborador.nome.toUpperCase());
    y += lh;
    doc.font(fN).fontSize(6);
    doc.text('Cargo: ', csx, y, { continued: true }); doc.font(fB).text(dados.colaborador.cargo || '-');
    y += lh;
    doc.font(fN).fontSize(6);
    doc.text('Período: ', csx, y, { continued: true }); doc.font(fB).text(dados.totaisExtendidos?.periodo || dados.mesAno);

    const hty = doc.page.margins.top + 3;
    doc.font(fN).fontSize(6).fillColor('#000000');
    doc.text('Empresa CPF/CNPJ: ', c2x, hty, { continued: true }); doc.font(fB).text(dados.empresa.cnpj);
    doc.font(fN).fontSize(6);
    doc.text('Colaborador CPF: ', c2x, hty + lh, { continued: true }); doc.font(fB).text(dados.colaborador.cpf);
    doc.font(fN).fontSize(6);
    doc.text('Admissão: ', c2x, hty + lh * 2, { continued: true }); doc.font(fB).text(dados.colaborador.dataAdmissao);

    doc.font(fN).fontSize(5.5).fillColor('#000000');
    doc.text(`Em: ${dados.totaisExtendidos?.geradoEm || ''}`, c3x, hty);
    doc.text(`Total de registros: ${dados.totaisExtendidos?.totalRegistros || 0}`, c3x, hty + lh);
    doc.text('Gerado pelo sistema: BluePoint', c3x, hty + lh * 2);

    y += lh + 3;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    y += 2;

    // ─── COLUNAS DA TABELA (13 colunas) ─────────────────
    const co = {
      data:      { x: lm,                   w: pageW * 0.085 },
      previsto:  { x: lm + pageW * 0.085,   w: pageW * 0.155 },
      inter:     { x: lm + pageW * 0.240,   w: pageW * 0.040 },
      realizado: { x: lm + pageW * 0.280,   w: pageW * 0.180 },
      intra:     { x: lm + pageW * 0.460,   w: pageW * 0.040 },
      hDiurn:    { x: lm + pageW * 0.500,   w: pageW * 0.050 },
      hNoturn:   { x: lm + pageW * 0.550,   w: pageW * 0.050 },
      hTotal:    { x: lm + pageW * 0.600,   w: pageW * 0.050 },
      heDiurn:   { x: lm + pageW * 0.650,   w: pageW * 0.050 },
      heNoturn:  { x: lm + pageW * 0.700,   w: pageW * 0.050 },
      heTotal:   { x: lm + pageW * 0.750,   w: pageW * 0.050 },
      hTrab:     { x: lm + pageW * 0.800,   w: pageW * 0.055 },
      atraso:    { x: lm + pageW * 0.855,   w: pageW * 0.055 },
    };

    const allCols = Object.values(co);
    const drawVLines = (yt: number, yb: number) => {
      doc.strokeColor('#000000').lineWidth(0.2);
      for (let i = 1; i < allCols.length; i++) {
        doc.moveTo(allCols[i].x - 1, yt).lineTo(allCols[i].x - 1, yb).stroke();
      }
    };

    // Cabeçalho da tabela
    const thY = y;
    doc.font(fB).fontSize(5.5).fillColor('#000000');
    doc.text('Data', co.data.x + 2, y, { width: co.data.w });
    doc.text('Previsto', co.previsto.x + 2, y, { width: co.previsto.w });
    doc.text('Inter-\njornada', co.inter.x + 1, y - 1, { width: co.inter.w, align: 'center', lineGap: -1 });
    doc.text('Realizado', co.realizado.x + 2, y, { width: co.realizado.w });
    doc.text('Intra-\njornada', co.intra.x + 1, y - 1, { width: co.intra.w, align: 'center', lineGap: -1 });
    doc.text('H.\ndiurnas', co.hDiurn.x + 1, y - 1, { width: co.hDiurn.w, align: 'center', lineGap: -1 });
    doc.text('H.\nnoturnas', co.hNoturn.x + 1, y - 1, { width: co.hNoturn.w, align: 'center', lineGap: -1 });
    doc.text('H. totais', co.hTotal.x + 1, y, { width: co.hTotal.w, align: 'center' });
    doc.text('HE\ndiurnas', co.heDiurn.x + 1, y - 1, { width: co.heDiurn.w, align: 'center', lineGap: -1 });
    doc.text('HE\nnoturnas', co.heNoturn.x + 1, y - 1, { width: co.heNoturn.w, align: 'center', lineGap: -1 });
    doc.text('HE\ntotais', co.heTotal.x + 1, y - 1, { width: co.heTotal.w, align: 'center', lineGap: -1 });
    doc.text('H. trab.', co.hTrab.x + 1, y, { width: co.hTrab.w, align: 'center' });
    doc.text('Atraso', co.atraso.x + 1, y, { width: co.atraso.w, align: 'center' });

    y += lh + 4;
    drawVLines(thY - 2, y);
    doc.strokeColor('#000000').lineWidth(0.3);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();

    const rh = lh;

    function drawCompleteTableHeader() {
      const hdrY = y;
      doc.font(fB).fontSize(5.5).fillColor('#000000');
      doc.text('Data', co.data.x + 2, y, { width: co.data.w });
      doc.text('Previsto', co.previsto.x + 2, y, { width: co.previsto.w });
      doc.text('Inter-jorn.', co.inter.x + 1, y, { width: co.inter.w, align: 'center' });
      doc.text('Realizado', co.realizado.x + 2, y, { width: co.realizado.w });
      doc.text('Intra-jorn.', co.intra.x + 1, y, { width: co.intra.w, align: 'center' });
      doc.text('H.diurn', co.hDiurn.x + 1, y, { width: co.hDiurn.w, align: 'center' });
      doc.text('H.not', co.hNoturn.x + 1, y, { width: co.hNoturn.w, align: 'center' });
      doc.text('H.tot', co.hTotal.x + 1, y, { width: co.hTotal.w, align: 'center' });
      doc.text('HE.d', co.heDiurn.x + 1, y, { width: co.heDiurn.w, align: 'center' });
      doc.text('HE.n', co.heNoturn.x + 1, y, { width: co.heNoturn.w, align: 'center' });
      doc.text('HE.t', co.heTotal.x + 1, y, { width: co.heTotal.w, align: 'center' });
      doc.text('H.trab', co.hTrab.x + 1, y, { width: co.hTrab.w, align: 'center' });
      doc.text('Atraso', co.atraso.x + 1, y, { width: co.atraso.w, align: 'center' });
      y += lh;
      drawVLines(hdrY - 2, y);
      doc.strokeColor('#000000').lineWidth(0.3);
      doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    }

    // ─── LINHAS DE DADOS ────────────────────────────────
    for (const dia of dados.dias) {
      if (y + rh > doc.page.height - doc.page.margins.bottom - 110) {
        doc.addPage();
        y = doc.page.margins.top;
        drawCompleteTableHeader();
      }

      y += 1;
      const rowTop = y - 1;
      const dFmt = `${formatDateShort(dia.data)} ${dia.diaSemana}`;

      doc.font(fN).fontSize(5.5).fillColor('#000000');
      doc.text(dFmt, co.data.x + 2, y, { width: co.data.w });

      if (dia.isFeriado && !dia.realizado) {
        doc.font(fB).fillColor('#CC8800').text('Feriado', co.previsto.x + 2, y, { width: co.previsto.w });
        doc.text('Feriado', co.realizado.x + 2, y, { width: co.realizado.w });
        doc.fillColor('#000000');
      } else if (dia.isFuturo && !dia.realizado) {
        doc.font(fN).text(dia.previsto, co.previsto.x + 2, y, { width: co.previsto.w });
        doc.text('', co.realizado.x + 2, y, { width: co.realizado.w });
      } else if (dia.isFolga) {
        doc.font(fB).text('Folga', co.previsto.x + 2, y, { width: co.previsto.w });
        doc.text(dia.realizado || 'Folga', co.realizado.x + 2, y, { width: co.realizado.w });
      } else if (dia.isFalta) {
        doc.font(fN).text(dia.previsto, co.previsto.x + 2, y, { width: co.previsto.w });
        doc.font(fB).fillColor('#cc0000').text('Falta', co.realizado.x + 2, y, { width: co.realizado.w });
        doc.fillColor('#000000');
      } else {
        doc.font(fN).text(dia.previsto, co.previsto.x + 2, y, { width: co.previsto.w });
        doc.text(dia.realizado, co.realizado.x + 2, y, { width: co.realizado.w });
      }

      doc.font(fN).fontSize(5.5).fillColor('#000000');
      doc.text(dia.interjornada || '', co.inter.x + 1, y, { width: co.inter.w, align: 'center' });
      doc.text(dia.intraJornada || '', co.intra.x + 1, y, { width: co.intra.w, align: 'center' });
      doc.text(dia.horasDiurnas || '00:00', co.hDiurn.x + 1, y, { width: co.hDiurn.w, align: 'center' });
      doc.text(dia.horasNoturnas || '00:00', co.hNoturn.x + 1, y, { width: co.hNoturn.w, align: 'center' });
      doc.text(dia.horasTrab, co.hTotal.x + 1, y, { width: co.hTotal.w, align: 'center' });
      doc.text(dia.heDiurnas || '00:00', co.heDiurn.x + 1, y, { width: co.heDiurn.w, align: 'center' });
      doc.text(dia.heNoturnas || '00:00', co.heNoturn.x + 1, y, { width: co.heNoturn.w, align: 'center' });
      doc.text(dia.heTotais || '00:00', co.heTotal.x + 1, y, { width: co.heTotal.w, align: 'center' });
      doc.text(dia.horasTrab, co.hTrab.x + 1, y, { width: co.hTrab.w, align: 'center' });

      const atrasoColor = dia.atrasoStr && dia.atrasoStr !== '00:00' ? '#cc0000' : '#000000';
      doc.fillColor(atrasoColor).text(dia.atrasoStr || '00:00', co.atraso.x + 1, y, { width: co.atraso.w, align: 'center' });
      doc.fillColor('#000000');

      y += rh - 1;
      drawVLines(rowTop, y);
      doc.strokeColor('#000000').lineWidth(0.15);
      doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    }

    // ─── LINHA DE TOTAIS ────────────────────────────────
    y += 1;
    const totRowTop = y - 1;
    doc.font(fB).fontSize(5.5).fillColor('#000000');
    const ext = dados.totaisExtendidos;
    doc.text(ext?.totalHorasDiurnas || dados.totais.horasTrabalhadas, co.hDiurn.x + 1, y, { width: co.hDiurn.w, align: 'center' });
    doc.text(ext?.totalHorasNoturnas || '00:00', co.hNoturn.x + 1, y, { width: co.hNoturn.w, align: 'center' });
    doc.text(dados.totais.horasTrabalhadas, co.hTotal.x + 1, y, { width: co.hTotal.w, align: 'center' });
    doc.text(ext?.totalHeDiurnas || dados.totais.horasExtras, co.heDiurn.x + 1, y, { width: co.heDiurn.w, align: 'center' });
    doc.text(ext?.totalHeNoturnas || '00:00', co.heNoturn.x + 1, y, { width: co.heNoturn.w, align: 'center' });
    doc.text(ext?.totalHeTotais || dados.totais.horasExtras, co.heTotal.x + 1, y, { width: co.heTotal.w, align: 'center' });
    doc.text(dados.totais.horasTrabalhadas, co.hTrab.x + 1, y, { width: co.hTrab.w, align: 'center' });
    doc.text(ext?.totalAtrasoStr || '00:00', co.atraso.x + 1, y, { width: co.atraso.w, align: 'center' });
    y += rh;
    drawVLines(totRowTop, y);
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();

    // ─── LEGENDA ────────────────────────────────────────
    y += 3;
    doc.font(fB).fontSize(5).fillColor('#000000');
    doc.text('Legenda:  ', lm + 2, y, { continued: true });
    doc.font(fN).text('(M) Marcação   (A) Ajuste Manual   (AB) Abono Parcial   (AT) Atestado Parcial   (HE) Horas extras   (BH) Banco de horas   (JH) Jornada híbrida');
    y += lh + 2;
    doc.strokeColor('#000000').lineWidth(0.3);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    y += 3;

    // ─── TABELAS RESUMO ────────────────────────────────
    const sfs = 5;
    const slh = 7.5;
    const gap = 4;
    const drawMiniTable = (x: number, yStart: number, w: number, titulo: string, linhas: string[][]) => {
      let ty = yStart;
      doc.font(fB).fontSize(sfs).fillColor('#000000');
      doc.text(titulo, x + 2, ty, { width: w });
      ty += slh;
      doc.strokeColor('#000000').lineWidth(0.2);
      doc.moveTo(x, ty).lineTo(x + w, ty).stroke();
      for (const linha of linhas) {
        ty += 1;
        const colW = w / linha.length;
        for (let i = 0; i < linha.length; i++) {
          const f = i === 0 ? fB : fN;
          doc.font(f).fontSize(sfs).fillColor('#000000');
          doc.text(linha[i], x + 2 + i * colW, ty, { width: colW - 4 });
        }
        ty += slh;
      }
      doc.strokeColor('#000000').lineWidth(0.2);
      doc.rect(x, yStart, w, ty - yStart).stroke();
      return ty;
    };

    const horasExtras = dados.totais.horasExtras;
    const bancoHoras = dados.totais.bancoHoras;

    if (footerMode === 'completo') {
      const secW1 = pageW * 0.16;
      const secW2 = pageW * 0.14;
      const secW3 = pageW * 0.30;
      const secW4 = pageW * 0.18;
      const secW5 = pageW * 0.18;

      const x1 = lm;
      const x2 = x1 + secW1 + gap;
      const x3 = x2 + secW2 + gap;
      const x4 = x3 + secW3 + gap;
      const x5 = x4 + secW4 + gap;

      drawMiniTable(x1, y, secW1, 'Total atrasos', [
        ['Tipo', 'Horas'],
        ['HE', horasExtras],
        ['BH', '00:00'],
        ['Total', horasExtras],
      ]);

      drawMiniTable(x2, y, secW2, 'Total H. Noturnas', [
        ['Tipo', 'Horas', 'Saldo'],
        ['', '00:00', '00:00'],
      ]);

      drawMiniTable(x3, y, secW3, 'Total de horas por escala de trabalho', [
        ['Tipo', 'Diurnas', 'Noturnas', 'Total'],
        ['Normal', ext?.totalHorasDiurnas || dados.totais.horasTrabalhadas, '00:00', dados.totais.horasTrabalhadas],
        ['Extra', ext?.totalHeDiurnas || horasExtras, '00:00', horasExtras],
      ]);

      drawMiniTable(x4, y, secW4, 'Total H.E. acumuladas', [
        ['Tipo', 'Horas'],
        ['Acumulado inicial', '00:00'],
        ['Saldo', horasExtras],
        ['Acumulado final', horasExtras],
      ]);

      const y1End = drawMiniTable(x5, y, secW5, 'Total do banco de horas', [
        ['Tipo', 'Horas'],
        ['Acumulado inicial', '00:00'],
        ['Saldo', bancoHoras],
        ['Acumulado final', bancoHoras],
      ]);

      y = y1End + 4;

      const ocW = pageW * 0.20;
      drawMiniTable(lm, y, ocW, 'Ocorrências', [
        ['Dia trabalhado', String(dados.totais.diasTrabalhados)],
        ['Faltas', String(dados.totais.faltas)],
        ['Atrasos', String(dados.totais.atrasos)],
        ['Folgas', String(ext?.folgas || 0)],
      ]);
    }

    if (footerMode === 'faixas_he') {
      const faixaW = pageW * 0.12;
      drawMiniTable(lm, y, faixaW, 'Faixas de\nhoras extras', [
        ['Sem config. --'],
      ]);
      y += 30;
    }

    // ─── ASSINATURAS ────────────────────────────────────
    const assinaturaDigital = dados.assinatura;
    const assAreaX = footerMode === 'completo' ? lm + pageW * 0.20 + gap * 2 : lm;
    const assAreaW = footerMode === 'completo' ? pageW - pageW * 0.20 - gap * 2 : pageW;

    if (assinaturaDigital) {
      let ay = y + 2;

      if (assinaturaDigital.assinaturaImagem) {
        try {
          const imgBuffer = Buffer.from(assinaturaDigital.assinaturaImagem, 'base64');
          doc.image(imgBuffer, assAreaX + (assAreaW - 120) / 2, ay, { width: 120, height: 40 });
          ay += 44;
        } catch {
          ay += 4;
        }
      }

      const lineX = assAreaX + (assAreaW - 250) / 2;
      doc.strokeColor('#000000').lineWidth(0.5);
      doc.moveTo(lineX, ay).lineTo(lineX + 250, ay).stroke();
      ay += 4;

      doc.font(fB).fontSize(5.5).fillColor('#000000');
      doc.text(
        `Assinado digitalmente por: ${assinaturaDigital.colaboradorNome} (#${assinaturaDigital.colaboradorId})`,
        assAreaX, ay, { width: assAreaW, align: 'center' }
      );
      ay += slh;
      doc.font(fN).fontSize(5.5);
      const dataFmt = (() => {
        try { return new Date(assinaturaDigital.assinadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
        catch { return assinaturaDigital.assinadoEm; }
      })();
      doc.text(`Em: ${dataFmt}`, assAreaX, ay, { width: assAreaW, align: 'center' });
      ay += slh;

      const det: string[] = [];
      if (assinaturaDigital.dispositivo) det.push(`Dispositivo: ${assinaturaDigital.dispositivo}`);
      if (assinaturaDigital.localizacaoGps) det.push(`GPS: ${assinaturaDigital.localizacaoGps}`);
      if (assinaturaDigital.ipAddress) det.push(`IP: ${assinaturaDigital.ipAddress}`);
      if (det.length > 0) {
        doc.text(det.join(' | '), assAreaX, ay, { width: assAreaW, align: 'center' });
        ay += slh;
      }

      doc.font(fN).fontSize(4.5).fillColor('#444444');
      doc.text('Declaro que concordo com os registros de ponto apresentados. Validade jurídica: MP 2.200-2/2001, Art. 10, §2º', assAreaX, ay, { width: assAreaW, align: 'center' });
    } else {
      const halfW = assAreaW * 0.45;
      const assY = y + 22;

      const colabX = assAreaX + (assAreaW / 2 - halfW) / 2;
      doc.strokeColor('#000000').lineWidth(0.5);
      doc.moveTo(colabX, assY).lineTo(colabX + halfW, assY).stroke();
      doc.font(fN).fontSize(5.5).fillColor('#000000');
      doc.text(dados.colaborador.nome.toUpperCase(), colabX, assY + 4, { width: halfW, align: 'center' });

      const empX = assAreaX + assAreaW / 2 + (assAreaW / 2 - halfW) / 2;
      doc.moveTo(empX, assY).lineTo(empX + halfW, assY).stroke();
      doc.text(dados.empresa.razaoSocial.toUpperCase(), empX, assY + 4, { width: halfW, align: 'center' });
    }

    doc.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gerarPDFPersonalizado(dados: DadosRelatorio): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const selectedIds = dados.colunasPersonalizadas || COLUNAS_PADRAO_DEFAULT;
    const colDefs = COLUNAS_PERSONALIZADO_DEFS.filter(c => selectedIds.includes(c.id));
    if (!colDefs.find(c => c.id === 'data')) {
      colDefs.unshift(COLUNAS_PERSONALIZADO_DEFS[0]);
    }

    const totalBase = colDefs.reduce((sum, c) => sum + c.larguraBase, 0);
    const scale = 1.0 / totalBase;

    const manyColumns = colDefs.length > 8;
    const tfs = manyColumns ? 5.5 : 7;
    const hfs = manyColumns ? 6 : 7.5;
    const lh = manyColumns ? 8 : 10;
    const mg = manyColumns
      ? { top: 22, bottom: 18, left: 22, right: 22 }
      : { top: 30, bottom: 30, left: 30, right: 30 };

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: mg,
      info: {
        Title: `Relatório Personalizado - ${dados.colaborador.nome} - ${dados.mesAno}`,
        Author: 'BluePoint',
      },
    });

    const buffers: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.on('data', (chunk: any) => buffers.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const lm = doc.page.margins.left;
    const fN = 'Helvetica';
    const fB = 'Helvetica-Bold';

    const columns = colDefs.map((c, i) => {
      let x = lm;
      for (let j = 0; j < i; j++) {
        x += colDefs[j].larguraBase * scale * pageW;
      }
      return { ...c, x, w: c.larguraBase * scale * pageW };
    });

    let y = doc.page.margins.top;

    // ─── HEADER ─────────────────────────────────────────
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    y += 4;

    let contentStartX = lm + 8;
    if (dados.logoPath && fs.existsSync(dados.logoPath)) {
      doc.image(dados.logoPath, lm + 8, y, { fit: [60, 50], align: 'center', valign: 'center' });
      contentStartX = lm + 80;
    }

    const col1X = contentStartX;
    const col2X = lm + pageW * 0.55;

    doc.font(fN).fontSize(hfs).fillColor('#000000');
    doc.text('Empresa: ', col1X, y, { continued: true });
    doc.font(fB).text(dados.empresa.razaoSocial.toUpperCase());
    y += lh;
    doc.font(fN).fontSize(hfs);
    doc.text('Colaborador: ', col1X, y, { continued: true });
    doc.font(fB).text(dados.colaborador.nome.toUpperCase());
    y += lh;
    doc.font(fN).fontSize(hfs);
    doc.text('Cargo: ', col1X, y, { continued: true });
    doc.font(fB).text(dados.colaborador.cargo || '-');
    y += lh;
    doc.font(fN).fontSize(hfs);
    doc.text('Período: ', col1X, y, { continued: true });
    doc.font(fB).text(dados.mesAno);

    const headerTopY = doc.page.margins.top + 4;
    doc.font(fN).fontSize(hfs).fillColor('#000000');
    doc.text(`CNPJ: ${dados.empresa.cnpj}`, col2X, headerTopY);
    doc.text(`CPF: ${dados.colaborador.cpf}`, col2X, headerTopY + lh);
    doc.text(`Admissão: ${dados.colaborador.dataAdmissao}`, col2X, headerTopY + lh * 2);

    y += lh + 4;
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    y += 3;

    // ─── TABLE HEADER ───────────────────────────────────
    const drawVLinesDyn = (yt: number, yb: number) => {
      doc.strokeColor('#000000').lineWidth(0.2);
      for (let i = 1; i < columns.length; i++) {
        doc.moveTo(columns[i].x - 1, yt).lineTo(columns[i].x - 1, yb).stroke();
      }
    };

    const drawTableHeaderDyn = () => {
      const thY = y;
      doc.font(fB).fontSize(tfs).fillColor('#000000');
      for (const col of columns) {
        doc.text(col.nome, col.x + 2, y, { width: col.w - 4, align: col.align });
      }
      y += lh;
      drawVLinesDyn(thY - 2, y);
      doc.strokeColor('#000000').lineWidth(0.3);
      doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    };

    drawTableHeaderDyn();

    const rh = lh;

    // ─── DATA ROWS ──────────────────────────────────────
    for (const dia of dados.dias) {
      if (y + rh > doc.page.height - doc.page.margins.bottom - 90) {
        doc.addPage();
        y = doc.page.margins.top;
        drawTableHeaderDyn();
      }

      y += 1;
      const rowTop = y - 1;

      for (const col of columns) {
        const val = getValorColuna(col.id, dia);
        doc.font(val.negrito ? fB : fN).fontSize(tfs);
        doc.fillColor(val.cor || '#000000');
        doc.text(val.texto, col.x + 2, y, { width: col.w - 4, align: col.align });
      }
      doc.fillColor('#000000');

      y += rh - 1;
      drawVLinesDyn(rowTop, y);
      doc.strokeColor('#000000').lineWidth(0.15);
      doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    }

    // ─── TOTALS ROW ─────────────────────────────────────
    y += 1;
    const totRowTop = y - 1;
    doc.font(fB).fontSize(tfs).fillColor('#000000');
    for (const col of columns) {
      const total = getTotalColuna(col.id, dados);
      if (total) {
        doc.text(total, col.x + 2, y, { width: col.w - 4, align: col.align });
      }
    }
    y += rh;
    drawVLinesDyn(totRowTop, y);
    doc.strokeColor('#000000').lineWidth(0.5);
    doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();

    // ─── RESUMO ─────────────────────────────────────────
    y += 4;
    doc.font(fB).fontSize(tfs).fillColor('#000000');
    doc.text(`Dias Trab.: ${dados.totais.diasTrabalhados}`, lm + 4, y);
    doc.text(`H. Trabalhadas: ${dados.totais.horasTrabalhadas}`, lm + pageW * 0.2, y);
    doc.text(`H. Extras: ${dados.totais.horasExtras}`, lm + pageW * 0.4, y);
    doc.text(`Banco H.: ${dados.totais.bancoHoras}`, lm + pageW * 0.6, y);
    doc.text(`Faltas: ${dados.totais.faltas}`, lm + pageW * 0.8, y);
    y += lh;
    doc.text(`Atrasos: ${dados.totais.atrasos}`, lm + 4, y);

    y += lh + 4;

    // ─── ASSINATURA ─────────────────────────────────────
    const assinaturaDigital = dados.assinatura;

    if (assinaturaDigital) {
      const blocoHeight = assinaturaDigital.assinaturaImagem ? 130 : 75;
      if (y + blocoHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top + 10;
      }

      doc.strokeColor('#333333').lineWidth(0.5);
      doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
      y += 6;

      if (assinaturaDigital.assinaturaImagem) {
        try {
          const imgBuffer = Buffer.from(assinaturaDigital.assinaturaImagem, 'base64');
          doc.image(imgBuffer, lm + (pageW - 140) / 2, y, { width: 140, height: 50 });
          y += 55;
        } catch {
          y += 4;
        }
      }

      const lineX = lm + (pageW - 300) / 2;
      doc.strokeColor('#000000').lineWidth(0.5);
      doc.moveTo(lineX, y).lineTo(lineX + 300, y).stroke();
      y += 6;

      doc.font(fB).fontSize(tfs).fillColor('#000000');
      doc.text(
        `Assinado digitalmente por: ${assinaturaDigital.colaboradorNome} (#${assinaturaDigital.colaboradorId})`,
        lm, y, { width: pageW, align: 'center' }
      );
      y += lh;

      doc.font(fN).fontSize(tfs);
      const dataFmt = (() => {
        try { return new Date(assinaturaDigital.assinadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
        catch { return assinaturaDigital.assinadoEm; }
      })();
      doc.text(
        `Em: ${dataFmt}${assinaturaDigital.dispositivo ? ` | Dispositivo: ${assinaturaDigital.dispositivo}` : ''}`,
        lm, y, { width: pageW, align: 'center' }
      );
      y += lh;

      const detalhes: string[] = [];
      if (assinaturaDigital.localizacaoGps) detalhes.push(`GPS: ${assinaturaDigital.localizacaoGps}`);
      if (assinaturaDigital.ipAddress) detalhes.push(`IP: ${assinaturaDigital.ipAddress}`);
      if (detalhes.length > 0) {
        doc.text(detalhes.join(' | '), lm, y, { width: pageW, align: 'center' });
        y += lh;
      }

      y += 4;
      doc.font(fN).fontSize(5).fillColor('#444444');
      doc.text(
        'Declaro que concordo com os registros de ponto apresentados. Validade jurídica: MP 2.200-2/2001, Art. 10, §2º',
        lm, y, { width: pageW, align: 'center' }
      );
      y += 8;
      doc.strokeColor('#333333').lineWidth(0.5);
      doc.moveTo(lm, y).lineTo(lm + pageW, y).stroke();
    } else {
      if (y + 45 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top + 20;
      }

      const assWidth = pageW * 0.4;
      const assY = y + 15;
      const assColabX = lm + (pageW / 2 - assWidth) / 2;
      doc.strokeColor('#000000').lineWidth(0.5);
      doc.moveTo(assColabX, assY).lineTo(assColabX + assWidth, assY).stroke();
      doc.font(fN).fontSize(tfs).fillColor('#000000');
      doc.text(dados.colaborador.nome.toUpperCase(), assColabX, assY + 6, { width: assWidth, align: 'center' });

      const assEmpX = lm + pageW / 2 + (pageW / 2 - assWidth) / 2;
      doc.moveTo(assEmpX, assY).lineTo(assEmpX + assWidth, assY).stroke();
      doc.text(dados.empresa.razaoSocial.toUpperCase(), assEmpX, assY + 6, { width: assWidth, align: 'center' });
    }

    doc.end();
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (req: NextRequest, user: JWTPayload) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);
      if (isNaN(colaboradorId)) {
        return errorResponse('ID do colaborador inválido', 400);
      }

      const { searchParams } = new URL(req.url);
      const mesParam = searchParams.get('mes');
      const anoParam = searchParams.get('ano');
      const modeloParam = (searchParams.get('modelo') || 'padrao') as ModeloPDF;
      const colunasParam = searchParams.get('colunas');

      if (!mesParam || !anoParam) {
        return errorResponse('Parâmetros mes e ano são obrigatórios', 400);
      }

      if (!geradores[modeloParam]) {
        return errorResponse(
          `Modelo "${modeloParam}" não encontrado. Modelos disponíveis: ${MODELOS_DISPONIVEIS.map(m => m.id).join(', ')}`,
          400
        );
      }

      let colunasPersonalizadas: string[] | undefined;
      if (modeloParam === 'personalizado') {
        if (colunasParam) {
          colunasPersonalizadas = colunasParam.split(',').map(c => c.trim());
        } else {
          const configResult = await query(
            `SELECT colunas FROM bt_config_relatorio_personalizado WHERE usuario_id = $1`,
            [user.userId]
          );
          if (configResult.rows.length > 0 && Array.isArray(configResult.rows[0].colunas) && configResult.rows[0].colunas.length > 0) {
            colunasPersonalizadas = configResult.rows[0].colunas;
          }
        }
      }

      const mes = parseInt(mesParam);
      const ano = parseInt(anoParam);

      if (mes < 1 || mes > 12) return errorResponse('Mês deve ser entre 1 e 12', 400);
      if (ano < 2020 || ano > 2100) return errorResponse('Ano inválido', 400);

      const colabResult = await query(
        `SELECT c.id, c.nome, c.cpf, c.cargo_id, cg.nome as cargo_nome, c.data_admissao,
                c.empresa_id, c.jornada_id,
                e.razao_social AS empresa_razao_social, e.cnpj AS empresa_cnpj
         FROM bluepoint.bt_colaboradores c
         LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
         LEFT JOIN bluepoint.bt_empresas e ON c.empresa_id = e.id
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
          dias_semana: r.dias_semana ? (typeof r.dias_semana === 'string' ? JSON.parse(r.dias_semana) : r.dias_semana) : null,
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
        if (!marcacoesPorDia.has(dataStr)) marcacoesPorDia.set(dataStr, []);
        marcacoesPorDia.get(dataStr)!.push({ data_hora: String(m.data_hora), tipo: m.tipo });
      }

      const feriadosResult = await query(
        `SELECT data, nome FROM bluepoint.bt_feriados
         WHERE data >= $1 AND data <= $2`,
        [dataInicio, dataFim]
      );
      const feriadosPorDia = new Map<string, string>();
      for (const f of feriadosResult.rows) {
        const fData = typeof f.data === 'string' ? f.data.substring(0, 10) : String(f.data).substring(0, 10);
        feriadosPorDia.set(fData, f.nome);
      }

      const feriasPorDia = await getDiasEmFeriasNoPeriodo(colaboradorId, dataInicio, dataFim);

      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const hojeStr = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

      const diasDoMes = gerarDiasDoMes(mes, ano);
      const diasPDF: DiaPDF[] = [];
      let totalDiasTrab = 0;
      let totalMinTrab = 0;
      let totalMinExtras = 0;
      let totalFaltas = 0;
      let totalAtrasos = 0;
      let totalAtrasoMinutos = 0;
      let totalFolgas = 0;
      let ultimaSaidaDiaAnterior: Date | null = null;

      for (const diaStr of diasDoMes) {
        const diaSemana = getDiaSemanaFromDate(diaStr);
        const horarioDia = encontrarHorarioDia(jornadaHorarios, diaSemana);
        const isFolga = horarioDia ? horarioDia.folga : false;
        const temEscala = !!horarioDia && !isFolga;
        const marcacoesDia = marcacoesPorDia.get(diaStr) || [];
        const isFeriado = feriadosPorDia.has(diaStr);
        const nomeFeriado = feriadosPorDia.get(diaStr) || '';
        const isFuturo = diaStr > hojeStr;
        const isFerias = feriasPorDia.has(diaStr);

        const minTrab = calcularMinutosTrabalhados(marcacoesDia);
        const cargaPrevista = temEscala ? calcularCargaPrevista(horarioDia!.periodos) : 0;

        let extrasMin = 0;
        let saldoMin = 0;

        if (marcacoesDia.length > 0) {
          totalDiasTrab++;
          totalMinTrab += minTrab;
          if (temEscala && cargaPrevista > 0) {
            if (minTrab > cargaPrevista) { extrasMin = minTrab - cargaPrevista; totalMinExtras += extrasMin; }
            saldoMin = minTrab - cargaPrevista;
          } else {
            extrasMin = minTrab; totalMinExtras += extrasMin; saldoMin = minTrab;
          }
        } else if (temEscala && !isFeriado && !isFuturo && !isFerias) {
          totalFaltas++;
          saldoMin = -cargaPrevista;
        }

        const isFalta = temEscala && marcacoesDia.length === 0 && !isFeriado && !isFuturo && !isFerias;
        let atrasoMinDia = 0;
        if (temEscala && marcacoesDia.length > 0) {
          const pe = marcacoesDia.find(m => m.tipo === 'entrada');
          if (pe && horarioDia!.periodos?.[0]) {
            const h = formatHoraMinuto(pe.data_hora);
            const [eh, em] = h.split(':').map(Number);
            const [ph, pm] = horarioDia!.periodos[0].entrada.split(':').map(Number);
            const diffAtraso = (eh * 60 + em) - (ph * 60 + pm);
            if (diffAtraso > 0) {
              totalAtrasos++;
              atrasoMinDia = diffAtraso;
              totalAtrasoMinutos += diffAtraso;
            }
          }
        }

        if (isFolga || isFeriado) totalFolgas++;

        let interjornada = '';
        if (marcacoesDia.length > 0 && ultimaSaidaDiaAnterior) {
          const primeiraEntrada = marcacoesDia.find(m => m.tipo === 'entrada');
          if (primeiraEntrada) {
            const entrada = parseTimestamp(primeiraEntrada.data_hora);
            if (entrada) {
              const diffMin = (entrada.getTime() - ultimaSaidaDiaAnterior.getTime()) / 60000;
              interjornada = diffMin >= 1440 ? '24h+' : minutosParaHHMM(Math.floor(diffMin));
            }
          }
        } else if (isFolga || marcacoesDia.length === 0) {
          interjornada = '24h+';
        }

        const ultimaSaida = [...marcacoesDia].reverse().find(m => m.tipo === 'saida');
        if (ultimaSaida) {
          ultimaSaidaDiaAnterior = parseTimestamp(ultimaSaida.data_hora);
        } else if (!isFolga && marcacoesDia.length > 0) {
          const ultimaMarc = marcacoesDia[marcacoesDia.length - 1];
          ultimaSaidaDiaAnterior = parseTimestamp(ultimaMarc.data_hora);
        }

        let intraJornada = '';
        const almoco = marcacoesDia.find(m => m.tipo === 'almoco');
        const retorno = marcacoesDia.find(m => m.tipo === 'retorno');
        if (almoco && retorno) {
          const a = parseTimestamp(almoco.data_hora);
          const r = parseTimestamp(retorno.data_hora);
          if (a && r) {
            const diffMin = (r.getTime() - a.getTime()) / 60000;
            if (diffMin > 0) intraJornada = minutosParaHHMM(Math.floor(diffMin));
          }
        }

        let realizadoStr: string;
        if (isFeriado && marcacoesDia.length === 0) {
          realizadoStr = 'Feriado';
        } else if (isFuturo && marcacoesDia.length === 0) {
          realizadoStr = '';
        } else if (isFerias && marcacoesDia.length === 0) {
          realizadoStr = 'Férias';
        } else if (isFolga && marcacoesDia.length === 0) {
          realizadoStr = 'Folga';
        } else if (isFalta) {
          realizadoStr = 'Falta';
        } else {
          realizadoStr = construirRealizadoString(marcacoesDia);
        }

        diasPDF.push({
          data: diaStr,
          diaSemana: DIAS_SEMANA_ABREV[diaSemana],
          previsto: isFeriado && marcacoesDia.length === 0
            ? 'Feriado'
            : isFuturo && marcacoesDia.length === 0
              ? ''
              : construirPrevistoString(horarioDia?.periodos || null, isFolga),
          realizado: realizadoStr,
          horasTrab: minutosParaHHMM(minTrab),
          horasExtras: minutosParaHHMM(extrasMin),
          saldo: minutosParaSaldo(saldoMin),
          isFolga: isFolga || isFeriado,
          isFalta,
          isFeriado,
          nomeFeriado,
          isFuturo,
          interjornada: interjornada || '',
          intraJornada,
          horasDiurnas: minutosParaHHMM(minTrab),
          horasNoturnas: '00:00',
          heDiurnas: minutosParaHHMM(extrasMin),
          heNoturnas: '00:00',
          heTotais: minutosParaHHMM(extrasMin),
          atrasoStr: atrasoMinDia > 0 ? minutosParaHHMM(atrasoMinDia) : '00:00',
        });
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
      const saldoBancoMin = Math.round(parseFloat(bancoResult.rows[0].saldo) * 60);

      const logoPath = path.join(process.cwd(), 'public', 'images', 'logo.png');
      const cpfFormatado = colab.cpf ? formatCPF(colab.cpf) : '-';
      const cnpjFormatado = colab.empresa_cnpj ? formatCNPJ(colab.empresa_cnpj) : '-';
      const admFormatada = colab.data_admissao
        ? (() => { const p = String(colab.data_admissao).substring(0, 10).split('-'); return `${p[2]}/${p[1]}/${p[0]}`; })()
        : '-';

      let assinatura: DadosAssinatura | null = null;
      const relResult = await query(
        `SELECT status, assinado_em, dispositivo, localizacao_gps, assinatura_imagem, ip_address
         FROM bluepoint.bt_relatorios_mensais
         WHERE colaborador_id = $1 AND mes = $2 AND ano = $3`,
        [colaboradorId, mes, ano]
      );
      if (relResult.rows.length > 0 && relResult.rows[0].status === 'assinado') {
        const rel = relResult.rows[0];
        assinatura = {
          assinadoEm: rel.assinado_em,
          colaboradorNome: colab.nome,
          colaboradorId,
          dispositivo: rel.dispositivo || null,
          localizacaoGps: rel.localizacao_gps || null,
          ipAddress: rel.ip_address || null,
          assinaturaImagem: rel.assinatura_imagem || null,
        };
      }

      const gerarPDF = geradores[modeloParam];
      const pdfBuffer = await gerarPDF({
        empresa: { razaoSocial: colab.empresa_razao_social || 'Empresa não informada', cnpj: cnpjFormatado },
        colaborador: { nome: colab.nome, cpf: cpfFormatado, cargo: colab.cargo_nome || '-', dataAdmissao: admFormatada },
        mesAno: `${MESES[mes - 1]} / ${ano}`,
        dias: diasPDF,
        totais: {
          diasTrabalhados: totalDiasTrab,
          horasTrabalhadas: minutosParaHHMM(totalMinTrab),
          horasExtras: minutosParaHHMM(totalMinExtras),
          bancoHoras: minutosParaSaldo(saldoBancoMin),
          faltas: totalFaltas,
          atrasos: totalAtrasos,
        },
        logoPath,
        assinatura,
        colunasPersonalizadas,
        totaisExtendidos: {
          totalHorasDiurnas: minutosParaHHMM(totalMinTrab),
          totalHorasNoturnas: '00:00',
          totalHeDiurnas: minutosParaHHMM(totalMinExtras),
          totalHeNoturnas: '00:00',
          totalHeTotais: minutosParaHHMM(totalMinExtras),
          totalAtrasoStr: minutosParaHHMM(totalAtrasoMinutos),
          folgas: totalFolgas,
          totalRegistros: marcacoesResult.rows.length,
          geradoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' (-03:00)',
          periodo: `${dataInicio.split('-').reverse().join('/')} - ${dataFim.split('-').reverse().join('/')}`,
        },
      });

      const mesNome = MESES[mes - 1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const nomeArquivo = `relatorio-${modeloParam}-${mesNome}-${ano}-${colab.nome.replace(/\s+/g, '-').toLowerCase()}.pdf`;
      const caminhoStorage = `relatorios/${colaboradorId}/${nomeArquivo}`;

      const url = await uploadArquivo(caminhoStorage, pdfBuffer, 'application/pdf');

      const expiraEm = new Date();
      expiraEm.setDate(expiraEm.getDate() + 7);

      return successResponse({
        url,
        modelo: modeloParam,
        modelosDisponiveis: MODELOS_DISPONIVEIS,
        expiraEm: expiraEm.toISOString().replace(/\.\d{3}Z$/, ''),
      });
    } catch (error) {
      console.error('Erro ao gerar PDF do relatório mensal:', error);
      return serverErrorResponse('Erro ao gerar PDF do relatório');
    }
  });
}
