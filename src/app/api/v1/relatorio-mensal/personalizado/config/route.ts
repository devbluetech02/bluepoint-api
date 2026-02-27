import { NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { query } from '@/lib/db';

const COLUNAS_DISPONIVEIS = [
  { id: 'data', nome: 'Data', obrigatoria: true },
  { id: 'previsto', nome: 'Previsto', obrigatoria: false },
  { id: 'interjornada', nome: 'Inter-jornada', obrigatoria: false },
  { id: 'realizado', nome: 'Realizado', obrigatoria: false },
  { id: 'intrajornada', nome: 'Intra-jornada', obrigatoria: false },
  { id: 'h_diurnas', nome: 'H. diurnas', obrigatoria: false },
  { id: 'h_noturnas', nome: 'H. noturnas', obrigatoria: false },
  { id: 'h_totais', nome: 'H. totais', obrigatoria: false },
  { id: 'he_diurnas', nome: 'HE diurnas', obrigatoria: false },
  { id: 'he_noturnas', nome: 'HE noturnas', obrigatoria: false },
  { id: 'he_totais', nome: 'HE totais', obrigatoria: false },
  { id: 'h_trab', nome: 'H. trab.', obrigatoria: false },
  { id: 'h_extras', nome: 'H. Extra', obrigatoria: false },
  { id: 'saldo', nome: 'Saldo', obrigatoria: false },
  { id: 'atraso', nome: 'Atraso', obrigatoria: false },
  { id: 'obs', nome: 'Obs', obrigatoria: false },
];

const COLUNAS_PADRAO_DEFAULT = ['data', 'previsto', 'realizado', 'h_trab', 'h_extras', 'saldo', 'obs'];

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req: NextRequest, user: JWTPayload) => {
    const result = await query(
      `SELECT colunas FROM bt_config_relatorio_personalizado WHERE usuario_id = $1`,
      [user.userId]
    );

    const colunasSelecionadas = result.rows.length > 0 && Array.isArray(result.rows[0].colunas) && result.rows[0].colunas.length > 0
      ? result.rows[0].colunas
      : COLUNAS_PADRAO_DEFAULT;

    return successResponse({
      colunasDisponiveis: COLUNAS_DISPONIVEIS,
      colunasSelecionadas,
      padrao: COLUNAS_PADRAO_DEFAULT,
    });
  });
}

export async function PUT(request: NextRequest) {
  return withAuth(request, async (req: NextRequest, user: JWTPayload) => {
    try {
      const body = await req.json();
      const { colunas } = body;

      if (!Array.isArray(colunas) || colunas.length === 0) {
        return errorResponse('O campo "colunas" deve ser um array não vazio de IDs de colunas', 400);
      }

      const idsValidos = COLUNAS_DISPONIVEIS.map(c => c.id);
      const invalidas = colunas.filter((c: string) => !idsValidos.includes(c));
      if (invalidas.length > 0) {
        return errorResponse(`Colunas inválidas: ${invalidas.join(', ')}. Colunas válidas: ${idsValidos.join(', ')}`, 400);
      }

      if (!colunas.includes('data')) {
        colunas.unshift('data');
      }

      await query(
        `INSERT INTO bt_config_relatorio_personalizado (usuario_id, colunas, atualizado_em)
         VALUES ($1, $2, NOW())
         ON CONFLICT (usuario_id)
         DO UPDATE SET colunas = $2, atualizado_em = NOW()`,
        [user.userId, JSON.stringify(colunas)]
      );

      return successResponse({
        colunasSelecionadas: colunas,
        mensagem: 'Configuração salva com sucesso',
      });
    } catch {
      return errorResponse('Erro ao salvar configuração', 500);
    }
  });
}
