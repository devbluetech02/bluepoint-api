import { NextRequest } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { uploadArquivo } from '@/lib/storage';
import {
  gerarBufferRelatorioMensal,
  geradoresRelatorio,
  MODELOS_RELATORIO_DISPONIVEIS,
  type ModeloRelatorio,
} from '../[id]/pdf/route';

const MESES = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

interface ColaboradorRow {
  id: number;
  nome: string;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (req: NextRequest, user: JWTPayload) => {
    try {
      const { searchParams } = new URL(req.url);
      const mesParam = searchParams.get('mes');
      const anoParam = searchParams.get('ano');
      const modeloParam = (searchParams.get('modelo') || 'padrao') as ModeloRelatorio;
      const colunasParam = searchParams.get('colunas');
      const busca = searchParams.get('busca');
      const departamentoIdParam = searchParams.get('departamentoId');

      if (!mesParam || !anoParam) {
        return errorResponse('Parâmetros mes e ano são obrigatórios', 400);
      }

      if (!geradoresRelatorio[modeloParam]) {
        return errorResponse(
          `Modelo "${modeloParam}" não encontrado. Modelos disponíveis: ${MODELOS_RELATORIO_DISPONIVEIS.map(m => m.id).join(', ')}`,
          400
        );
      }

      const mes = parseInt(mesParam);
      const ano = parseInt(anoParam);
      if (mes < 1 || mes > 12) return errorResponse('Mês deve ser entre 1 e 12', 400);
      if (ano < 2020 || ano > 2100) return errorResponse('Ano inválido', 400);

      let colunasPersonalizadas: string[] | undefined;
      if (modeloParam === 'personalizado') {
        if (colunasParam) {
          colunasPersonalizadas = colunasParam.split(',').map(c => c.trim());
        } else {
          const configResult = await query(
            `SELECT colunas FROM config_relatorio_personalizado WHERE usuario_id = $1`,
            [user.userId]
          );
          if (
            configResult.rows.length > 0 &&
            Array.isArray(configResult.rows[0].colunas) &&
            configResult.rows[0].colunas.length > 0
          ) {
            colunasPersonalizadas = configResult.rows[0].colunas;
          }
        }
      }

      // ─── Busca colaboradores aplicando os mesmos filtros do front ───────
      const conditions: string[] = [`c.status = 'ativo'`];
      const params: unknown[] = [];
      let p = 1;
      if (busca) {
        conditions.push(
          `(c.nome ILIKE $${p} OR c.email ILIKE $${p} OR c.cpf ILIKE $${p})`
        );
        params.push(`%${busca}%`);
        p++;
      }
      if (departamentoIdParam) {
        conditions.push(`c.departamento_id = $${p}`);
        params.push(parseInt(departamentoIdParam));
        p++;
      }
      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const colaboradoresResult = await query(
        `SELECT c.id, c.nome
         FROM people.colaboradores c
         ${whereClause}
         ORDER BY c.nome ASC`,
        params
      );
      const colaboradores: ColaboradorRow[] = colaboradoresResult.rows.map(r => ({
        id: Number(r.id),
        nome: String(r.nome),
      }));

      if (colaboradores.length === 0) {
        return errorResponse('Nenhum colaborador encontrado para os filtros informados', 404);
      }

      // ─── Gera o PDF de cada colaborador e mescla em um único PDF ────────
      const merged = await PDFDocument.create();
      let mesclados = 0;

      for (const colab of colaboradores) {
        try {
          const { buffer } = await gerarBufferRelatorioMensal({
            colaboradorId: colab.id,
            mes,
            ano,
            modelo: modeloParam,
            colunasPersonalizadas,
          });
          const src = await PDFDocument.load(buffer);
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const page of pages) merged.addPage(page);
          mesclados++;
        } catch (err) {
          console.error(`[pdf-todos] Falha ao gerar PDF do colaborador ${colab.id}:`, err);
        }
      }

      if (mesclados === 0) {
        return serverErrorResponse('Não foi possível gerar nenhum PDF para os colaboradores selecionados');
      }

      const mergedBytes = await merged.save();
      const pdfBuffer = Buffer.from(mergedBytes);

      const mesNome = MESES[mes - 1];
      const nomeArquivo = `folha-ponto-todos-${modeloParam}-${mesNome}-${ano}.pdf`;
      const caminhoStorage = `relatorios/_consolidado/${ano}-${String(mes).padStart(2, '0')}/${nomeArquivo}`;

      const url = await uploadArquivo(caminhoStorage, pdfBuffer, 'application/pdf');

      const expiraEm = new Date();
      expiraEm.setDate(expiraEm.getDate() + 7);

      return successResponse({
        url,
        modelo: modeloParam,
        modelosDisponiveis: MODELOS_RELATORIO_DISPONIVEIS,
        expiraEm: expiraEm.toISOString().replace(/\.\d{3}Z$/, ''),
        totalColaboradores: colaboradores.length,
        colaboradoresIncluidos: mesclados,
      });
    } catch (error) {
      console.error('Erro ao gerar PDF consolidado de todos os colaboradores:', error);
      return serverErrorResponse('Erro ao gerar PDF consolidado');
    }
  });
}
