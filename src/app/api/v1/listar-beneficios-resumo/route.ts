import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, errorResponse, buildPaginatedResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getDiasDescontoPorColaborador } from '@/lib/beneficios-desconto';

function valorVABasePorTipo(
  tipo: string,
  params: {
    valorValeAlimentacaoColaborador: number;
    valorValeAlimentacaoSupervisor: number;
    valorValeAlimentacaoCoordenador: number;
  }
): number {
  if (tipo === 'supervisor') return params.valorValeAlimentacaoSupervisor;
  if (['coordenador', 'gestor', 'gerente', 'admin'].includes(tipo)) return params.valorValeAlimentacaoCoordenador;
  return params.valorValeAlimentacaoColaborador;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const mesReferencia = searchParams.get('mesReferencia');
      if (!mesReferencia || !/^\d{4}-\d{2}$/.test(mesReferencia)) {
        return errorResponse('mesReferencia é obrigatório e deve estar no formato YYYY-MM', 400);
      }
      const [anoStr, mesStr] = mesReferencia.split('-');
      const ano = parseInt(anoStr, 10);
      const mes = parseInt(mesStr, 10);
      if (ano < 2020 || ano > 2100 || mes < 1 || mes > 12) {
        return errorResponse('mesReferencia inválido', 400);
      }

      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const busca = searchParams.get('busca');

      const conditions: string[] = ["c.status = 'ativo'"];
      const params: unknown[] = [];
      let paramIndex = 1;
      if (busca) {
        conditions.push(`(c.nome ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.cpf ILIKE $${paramIndex})`);
        params.push(`%${busca}%`);
        paramIndex++;
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await query(
        `SELECT COUNT(*) as total FROM people.colaboradores c ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      const dataParams = [...params, limite, offset];
      const result = await query(
        `SELECT c.id, c.nome, c.cpf, c.tipo, c.vale_alimentacao, c.vale_transporte,
                d.id as departamento_id, d.nome as departamento_nome,
                cg.id as cargo_id, cg.nome as cargo_nome
         FROM people.colaboradores c
         LEFT JOIN people.departamentos d ON c.departamento_id = d.id
         LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
         ${whereClause}
         ORDER BY c.nome
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
      );

      let parametros = {
        valorValeTransporte: 17.5,
        valorValeAlimentacaoColaborador: 660,
        valorValeAlimentacaoSupervisor: 800,
        valorValeAlimentacaoCoordenador: 1000,
        horasMinimasParaValeAlimentacao: 6,
        diasUteisMes: 22,
      };
      const paramRes = await query(
        `SELECT valor_vale_transporte, valor_vale_alimentacao_colaborador,
                valor_vale_alimentacao_supervisor, valor_vale_alimentacao_coordenador,
                horas_minimas_para_vale_alimentacao, dias_uteis_mes
         FROM people.parametros_beneficios ORDER BY id DESC LIMIT 1`
      );
      if (paramRes.rows.length > 0) {
        const r = paramRes.rows[0];
        parametros = {
          valorValeTransporte: Number(r.valor_vale_transporte),
          valorValeAlimentacaoColaborador: Number(r.valor_vale_alimentacao_colaborador),
          valorValeAlimentacaoSupervisor: Number(r.valor_vale_alimentacao_supervisor),
          valorValeAlimentacaoCoordenador: Number(r.valor_vale_alimentacao_coordenador),
          horasMinimasParaValeAlimentacao: Number(r.horas_minimas_para_vale_alimentacao),
          diasUteisMes: Number(r.dias_uteis_mes),
        };
      }

      const ids = result.rows.map(r => Number((r as { id: number }).id));
      const diasDescontoMap = await getDiasDescontoPorColaborador(
        ano,
        mes,
        ids,
        parametros.horasMinimasParaValeAlimentacao
      );

      const diasUteis = parametros.diasUteisMes;
      const dados = result.rows.map((row: Record<string, unknown>) => {
        const diasDesconto = diasDescontoMap.get(Number(row.id)) ?? 0;
        const tipo = (row.tipo as string) ?? 'colaborador';
        const valorVABase = valorVABasePorTipo(tipo, parametros);
        const valorVTDiario = parametros.valorValeTransporte;
        const diasComDireito = Math.max(0, diasUteis - diasDesconto);
        const valorPrevistoMesQueVem =
          diasUteis > 0
            ? (diasComDireito / diasUteis) * valorVABase + valorVTDiario * diasComDireito
            : 0;

        return {
          colaboradorId: row.id,
          nome: row.nome,
          matricula: row.cpf ?? null,
          departamento: row.departamento_id
            ? { id: row.departamento_id, nome: row.departamento_nome }
            : null,
          cargo: row.cargo_id ? { id: row.cargo_id, nome: row.cargo_nome } : null,
          tipo,
          valeAlimentacao: row.vale_alimentacao === true,
          valeTransporte: row.vale_transporte === true,
          valorVABase,
          valorVTDiario,
          diasUteisMes: diasUteis,
          diasDesconto,
          mesReferencia,
          valorPrevistoMesQueVem: Math.round(valorPrevistoMesQueVem * 100) / 100,
        };
      });

      return successResponse(
        buildPaginatedResponse(dados, total, pagina, limite)
      );
    } catch (error) {
      console.error('Erro ao listar resumo de benefícios:', error);
      return serverErrorResponse('Erro ao listar resumo de benefícios');
    }
  });
}
