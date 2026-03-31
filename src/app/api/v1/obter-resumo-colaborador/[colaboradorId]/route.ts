import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req) => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const { searchParams } = new URL(req.url);
      const periodo = searchParams.get('periodo') || 'mes';

      // Verificar colaborador
      const colaboradorResult = await query(
        `SELECT c.id, c.nome, c.email, c.cargo_id, cg.nome as cargo_nome, c.foto_url
         FROM people.colaboradores c
         LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
         WHERE c.id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = colaboradorResult.rows[0];

      const cacheKey = `${CACHE_KEYS.RESUMO_COLABORADOR}${colaboradorId}:${periodo}`;

      const dados = await cacheAside(cacheKey, async () => {
        // Definir intervalo de datas
        let intervalo = "data_hora >= CURRENT_DATE - INTERVAL '30 days'";
        if (periodo === 'hoje') {
          intervalo = 'DATE(data_hora) = CURRENT_DATE';
        } else if (periodo === 'semana') {
          intervalo = "data_hora >= CURRENT_DATE - INTERVAL '7 days'";
        }

        // Estatísticas de marcações
        const estatisticasResult = await query(
          `SELECT 
            COUNT(DISTINCT DATE(data_hora)) as dias_trabalhados,
            COUNT(*) as total_marcacoes
          FROM people.marcacoes
          WHERE colaborador_id = $1 AND ${intervalo}`,
          [colaboradorId]
        );

        // Últimas marcações
        const ultimasMarcacoesResult = await query(
          `SELECT id, data_hora, tipo, metodo
           FROM people.marcacoes
           WHERE colaborador_id = $1
           ORDER BY data_hora DESC
           LIMIT 5`,
          [colaboradorId]
        );

        // Saldo de banco de horas
        const saldoResult = await query(
          `SELECT saldo_atual FROM banco_horas
           WHERE colaborador_id = $1
           ORDER BY criado_em DESC
           LIMIT 1`,
          [colaboradorId]
        );

        // Próximas férias
        const feriasResult = await query(
          `SELECT data_evento, data_evento_fim, dados_adicionais
           FROM solicitacoes
           WHERE colaborador_id = $1 
           AND tipo = 'ferias' 
           AND status = 'aprovada'
           AND data_evento >= CURRENT_DATE
           ORDER BY data_evento
           LIMIT 1`,
          [colaboradorId]
        );

        const estatisticas = estatisticasResult.rows[0];
        const saldo = saldoResult.rows.length > 0 ? parseFloat(saldoResult.rows[0].saldo_atual) : 0;

        return {
          colaborador: {
            id: colaborador.id,
            nome: colaborador.nome,
            email: colaborador.email,
            cargo: colaborador.cargo_id ? { id: colaborador.cargo_id, nome: colaborador.cargo_nome } : null,
            foto: colaborador.foto_url,
          },
          periodo,
          estatisticas: {
            diasTrabalhados: parseInt(estatisticas.dias_trabalhados) || 0,
            horasTrabalhadas: 0,
            horasExtras: saldo > 0 ? saldo : 0,
            atrasos: 0,
            saidasAntecipadas: 0,
            faltas: 0,
            taxaPresenca: 0,
            taxaPontualidade: 0,
          },
          ultimasMarcacoes: ultimasMarcacoesResult.rows.map(m => ({
            id: m.id,
            dataHora: m.data_hora,
            tipo: m.tipo,
            metodo: m.metodo,
          })),
          proximasFerias: feriasResult.rows.length > 0 ? {
            dataInicio: feriasResult.rows[0].data_evento,
            dataFim: feriasResult.rows[0].data_evento_fim,
            dias: feriasResult.rows[0].dados_adicionais?.dias,
          } : null,
        };
      }, CACHE_TTL.SHORT);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao obter resumo do colaborador:', error);
      return serverErrorResponse('Erro ao obter resumo');
    }
  });
}
