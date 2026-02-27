import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const visaoGeral = await cacheAside(`${CACHE_KEYS.VISAO_GERAL}dashboard`, async () => {
        // Total de colaboradores
        const colaboradoresResult = await query(
          `SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'ativo' THEN 1 ELSE 0 END) as ativos
          FROM bluepoint.bt_colaboradores`
        );

        // Marcações de hoje
        const marcacoesHojeResult = await query(
          `SELECT 
            COUNT(DISTINCT colaborador_id) as presentes,
            SUM(CASE WHEN tipo = 'entrada' THEN 1 ELSE 0 END) as entradas,
            SUM(CASE WHEN tipo = 'saida' THEN 1 ELSE 0 END) as saidas,
            SUM(CASE WHEN tipo = 'almoco' THEN 1 ELSE 0 END) as almocos,
            SUM(CASE WHEN tipo = 'retorno' THEN 1 ELSE 0 END) as retornos
          FROM bluepoint.bt_marcacoes
          WHERE DATE(data_hora) = CURRENT_DATE`
        );

        // Colaboradores ativos que não registraram entrada hoje
        const ausentesResult = await query(
          `SELECT COUNT(*) as ausentes
          FROM bluepoint.bt_colaboradores c
          WHERE c.status = 'ativo'
          AND c.id NOT IN (
            SELECT DISTINCT colaborador_id 
            FROM bluepoint.bt_marcacoes 
            WHERE DATE(data_hora) = CURRENT_DATE
          )`
        );

        // Horas extras do mês
        const horasExtrasResult = await query(
          `SELECT COALESCE(SUM(CASE WHEN horas > 0 THEN horas ELSE 0 END), 0) as total
          FROM bt_banco_horas
          WHERE EXTRACT(MONTH FROM data) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND EXTRACT(YEAR FROM data) = EXTRACT(YEAR FROM CURRENT_DATE)`
        );

        // Presença semanal (últimos 7 dias)
        const presencaSemanalResult = await query(
          `SELECT 
            DATE(data_hora) as data,
            COUNT(DISTINCT colaborador_id) as presentes
          FROM bluepoint.bt_marcacoes
          WHERE data_hora >= CURRENT_DATE - INTERVAL '7 days'
          GROUP BY DATE(data_hora)
          ORDER BY data`
        );

        // Distribuição por departamento
        const departamentosResult = await query(
          `SELECT 
            d.nome,
            COUNT(c.id) as total
          FROM bt_departamentos d
          LEFT JOIN bluepoint.bt_colaboradores c ON d.id = c.departamento_id AND c.status = 'ativo'
          WHERE d.status = 'ativo'
          GROUP BY d.id, d.nome
          ORDER BY total DESC
          LIMIT 5`
        );

        const totais = colaboradoresResult.rows[0];
        const marcacoesHoje = marcacoesHojeResult.rows[0];
        const ausentes = ausentesResult.rows[0];
        const horasExtras = horasExtrasResult.rows[0];

        return {
          periodo: {
            inicio: new Date().toISOString().split('T')[0],
            fim: new Date().toISOString().split('T')[0],
          },
          totalizadores: {
            totalColaboradores: parseInt(totais.total),
            colaboradoresAtivos: parseInt(totais.ativos),
            presencaHoje: parseInt(marcacoesHoje.presentes) || 0,
            ausenciasHoje: parseInt(ausentes.ausentes) || 0,
            atrasosHoje: 0, // Seria calculado comparando com jornadas
            horasExtrasMes: parseFloat(horasExtras.total) || 0,
          },
          graficos: {
            presencaSemanal: presencaSemanalResult.rows.map(r => ({
              data: r.data,
              presentes: parseInt(r.presentes),
            })),
            departamentos: departamentosResult.rows.map(r => ({
              nome: r.nome,
              total: parseInt(r.total),
            })),
            tendencias: [],
          },
        };
      }, CACHE_TTL.SHORT);

      return successResponse(visaoGeral);
    } catch (error) {
      console.error('Erro ao obter visão geral:', error);
      return serverErrorResponse('Erro ao obter visão geral');
    }
  });
}
