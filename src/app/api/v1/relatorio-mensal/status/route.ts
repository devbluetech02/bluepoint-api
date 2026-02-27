import { NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { query } from '@/lib/db';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req: NextRequest) => {
    const { searchParams } = new URL(req.url);
    const mesParam = searchParams.get('mes');
    const anoParam = searchParams.get('ano');
    const idsParam = searchParams.get('colaboradorIds');

    if (!mesParam || !anoParam) {
      return errorResponse('Parâmetros mes e ano são obrigatórios', 400);
    }

    const mes = parseInt(mesParam);
    const ano = parseInt(anoParam);

    if (mes < 1 || mes > 12) return errorResponse('Mês deve ser entre 1 e 12', 400);
    if (ano < 2020 || ano > 2100) return errorResponse('Ano inválido', 400);

    let colaboradorIds: number[] = [];
    if (idsParam) {
      colaboradorIds = idsParam.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (colaboradorIds.length === 0) {
        return errorResponse('Nenhum ID de colaborador válido informado', 400);
      }
    }

    let sql: string;
    let params: unknown[];

    if (colaboradorIds.length > 0) {
      const placeholders = colaboradorIds.map((_, i) => `$${i + 3}`).join(',');
      sql = `
        SELECT c.id AS colaborador_id, c.nome, r.status, r.assinado_em
        FROM bluepoint.bt_colaboradores c
        LEFT JOIN bluepoint.bt_relatorios_mensais r
          ON r.colaborador_id = c.id AND r.mes = $1 AND r.ano = $2
        WHERE c.id IN (${placeholders})
        ORDER BY c.nome
      `;
      params = [mes, ano, ...colaboradorIds];
    } else {
      sql = `
        SELECT c.id AS colaborador_id, c.nome, r.status, r.assinado_em
        FROM bluepoint.bt_colaboradores c
        LEFT JOIN bluepoint.bt_relatorios_mensais r
          ON r.colaborador_id = c.id AND r.mes = $1 AND r.ano = $2
        WHERE c.status = 'ativo'
        ORDER BY c.nome
      `;
      params = [mes, ano];
    }

    const result = await query(sql, params);

    const data = result.rows.map(row => ({
      colaboradorId: row.colaborador_id,
      nome: row.nome,
      status: row.status || 'pendente',
      assinadoEm: row.assinado_em || null,
    }));

    return successResponse(data);
  });
}
