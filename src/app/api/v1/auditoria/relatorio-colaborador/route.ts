import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, forbiddenResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

function formatDateBR(dateStr: string): string {
  if (!dateStr) return '';
  const d = dateStr.substring(0, 10);
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function formatDateTimeBR(raw: string): string {
  if (!raw) return '';
  const str = String(raw);
  const datePart = str.substring(0, 10);
  const timePart = str.substring(11, 19) || '';
  return `${formatDateBR(datePart)} ${timePart}`.trim();
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? text.substring(0, max - 3) + '...' : text;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const params = req.nextUrl.searchParams;
      const colaboradorId = params.get('colaboradorId');
      const dataInicio = params.get('dataInicio');
      const dataFim = params.get('dataFim');

      if (!colaboradorId || !dataInicio || !dataFim) {
        return errorResponse('Parâmetros obrigatórios: colaboradorId, dataInicio, dataFim', 400);
      }

      const colabIdNum = parseInt(colaboradorId);
      if (isNaN(colabIdNum)) {
        return errorResponse('colaboradorId deve ser um número', 400);
      }

      // Relatório de auditoria contém histórico sensível — só próprio,
      // admin ou gestor com escopo podem gerar pra outro.
      const acesso = await asseguraAcessoColaborador(user, colabIdNum);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      const colabResult = await query<{
        nome: string;
        email: string;
        cpf: string;
        cargo_nome: string | null;
        departamento_nome: string | null;
        empresa_nome: string | null;
      }>(
        `SELECT
           c.nome,
           c.email,
           c.cpf,
           ca.nome AS cargo_nome,
           d.nome AS departamento_nome,
           e.razao_social AS empresa_nome
         FROM colaboradores c
         LEFT JOIN cargos ca ON c.cargo_id = ca.id
         LEFT JOIN departamentos d ON c.departamento_id = d.id
         LEFT JOIN empresas e ON c.empresa_id = e.id
         WHERE c.id = $1`,
        [colabIdNum]
      );

      if (colabResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      const colab = colabResult.rows[0];

      const logsResult = await query<{
        data_hora: string;
        usuario_nome: string;
        acao: string;
        modulo: string;
        descricao: string;
        ip: string;
      }>(
        `SELECT
           a.data_hora,
           COALESCE(c.nome, 'Sistema') AS usuario_nome,
           a.acao,
           a.modulo,
           a.descricao,
           a.ip
         FROM auditoria a
         LEFT JOIN colaboradores c ON a.usuario_id = c.id
         WHERE a.colaborador_id = $1
           AND a.data_hora >= $2::date
           AND a.data_hora < ($3::date + interval '1 day')
         ORDER BY a.data_hora ASC`,
        [colabIdNum, dataInicio, dataFim]
      );

      const logs = logsResult.rows;

      // --- Gerar PDF ---
      const fontDir = path.join(process.cwd(), 'public', 'fonts');
      const hasCustomFont = fs.existsSync(path.join(fontDir, 'Helvetica.ttf'));

      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 40, bottom: 40, left: 40, right: 40 },
        bufferPages: true,
        info: {
          Title: `Relatório de Auditoria - ${colab.nome}`,
          Author: 'BluePoint',
          Subject: 'Auditoria do Colaborador',
          CreationDate: new Date(),
        },
      });

      if (hasCustomFont) {
        doc.registerFont('Regular', path.join(fontDir, 'Helvetica.ttf'));
        doc.registerFont('Bold', path.join(fontDir, 'Helvetica-Bold.ttf'));
      }

      const fontRegular = hasCustomFont ? 'Regular' : 'Helvetica';
      const fontBold = hasCustomFont ? 'Bold' : 'Helvetica-Bold';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfDoc = doc as any;

      const pageW = doc.page.width;
      const marginL = doc.page.margins.left;
      const marginR = doc.page.margins.right;
      const usableW = pageW - marginL - marginR;

      const buffers: Buffer[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc.on('data', (chunk: any) => buffers.push(Buffer.from(chunk)));

      const pdfReady = new Promise<Buffer>((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);
      });

      // --- Cabeçalho ---
      const drawHeader = () => {
        doc.font(fontBold).fontSize(16).fillColor('#1a365d')
          .text('Relatório de Auditoria do Colaborador', marginL, 40, { align: 'center', width: usableW });

        pdfDoc.moveDown(0.5);

        const infoY = doc.y;
        doc.font(fontBold).fontSize(9).fillColor('#333');

        doc.text('Colaborador:', marginL, infoY);
        doc.font(fontRegular).text(colab.nome, marginL + 75, infoY);

        doc.font(fontBold).text('CPF:', marginL + 300, infoY);
        doc.font(fontRegular).text(colab.cpf || '—', marginL + 325, infoY);

        doc.font(fontBold).text('Período:', marginL + 500, infoY);
        doc.font(fontRegular).text(`${formatDateBR(dataInicio)} a ${formatDateBR(dataFim)}`, marginL + 545, infoY);

        const infoY2 = infoY + 14;
        doc.font(fontBold).text('Cargo:', marginL, infoY2);
        doc.font(fontRegular).text(colab.cargo_nome || '—', marginL + 75, infoY2);

        doc.font(fontBold).text('Departamento:', marginL + 300, infoY2);
        doc.font(fontRegular).text(colab.departamento_nome || '—', marginL + 375, infoY2);

        doc.font(fontBold).text('Empresa:', marginL + 500, infoY2);
        doc.font(fontRegular).text(colab.empresa_nome || '—', marginL + 545, infoY2);

        doc.y = infoY2 + 22;

        doc.moveTo(marginL, doc.y).lineTo(pageW - marginR, doc.y)
          .strokeColor('#1a365d').lineWidth(1).stroke();

        doc.y += 8;
      };

      drawHeader();

      // --- Tabela ---
      const colWidths = [110, 120, 80, 100, usableW - 410 - 60, 60];
      const colHeaders = ['Data/Hora', 'Usuário', 'Ação', 'Módulo', 'Detalhes', 'IP'];
      const rowHeight = 18;
      const headerRowHeight = 22;

      const drawTableHeader = () => {
        const y = doc.y;
        doc.rect(marginL, y, usableW, headerRowHeight).fill('#1a365d');

        let xPos = marginL + 4;
        doc.font(fontBold).fontSize(8).fillColor('#ffffff');

        for (let i = 0; i < colHeaders.length; i++) {
          doc.text(colHeaders[i], xPos, y + 6, { width: colWidths[i] - 8 });
          xPos += colWidths[i];
        }

        doc.y = y + headerRowHeight;
      };

      drawTableHeader();

      for (let idx = 0; idx < logs.length; idx++) {
        const log = logs[idx];

        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
          doc.addPage();
          drawHeader();
          drawTableHeader();
        }

        const y = doc.y;
        const bgColor = idx % 2 === 0 ? '#f7fafc' : '#ffffff';
        doc.rect(marginL, y, usableW, rowHeight).fill(bgColor);

        let xPos = marginL + 4;
        doc.font(fontRegular).fontSize(7.5).fillColor('#333');

        const cells = [
          formatDateTimeBR(log.data_hora),
          truncate(log.usuario_nome, 22),
          log.acao,
          log.modulo,
          truncate(log.descricao, 65),
          truncate(log.ip, 15),
        ];

        for (let i = 0; i < cells.length; i++) {
          doc.text(cells[i] || '', xPos, y + 5, { width: colWidths[i] - 8 });
          xPos += colWidths[i];
        }

        doc.y = y + rowHeight;
      }

      if (logs.length === 0) {
        pdfDoc.moveDown(1);
        doc.font(fontRegular).fontSize(10).fillColor('#666')
          .text('Nenhum registro de auditoria encontrado neste período.', marginL, doc.y, { align: 'center', width: usableW });
      }

      pdfDoc.moveDown(1);
      doc.moveTo(marginL, doc.y).lineTo(pageW - marginR, doc.y)
        .strokeColor('#ccc').lineWidth(0.5).stroke();
      doc.y += 6;

      doc.font(fontRegular).fontSize(7).fillColor('#999');
      doc.text(`Total de registros: ${logs.length}`, marginL, doc.y);
      doc.text(
        `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} por ${user.nome}`,
        marginL, doc.y, { align: 'right', width: usableW }
      );

      doc.end();

      const pdfBuffer = await pdfReady;

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'exportar',
        modulo: 'auditoria',
        descricao: `Relatório PDF de auditoria do colaborador ${colab.nome} (${formatDateBR(dataInicio)} a ${formatDateBR(dataFim)})`,
        colaboradorId: colabIdNum,
        colaboradorNome: colab.nome,
      }));

      const filename = `auditoria-colaborador-${colabIdNum}-${dataInicio}_${dataFim}.pdf`;

      return new Response(pdfBuffer as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(pdfBuffer.length),
        },
      });
    } catch (error) {
      console.error('Erro ao gerar relatório de auditoria:', error);
      return serverErrorResponse('Erro ao gerar relatório de auditoria');
    }
  });
}
