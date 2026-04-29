import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, forbiddenResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getDayName, formatDateBR } from '@/lib/utils';
import { resolverColaboradorIdComAcesso, obterEscopoGestor, listarColaboradoresNoEscopo } from '@/lib/escopo-gestor';
import { isSuperAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const colaboradorIdParam = searchParams.get('colaboradorId');
      const departamentoId = searchParams.get('departamentoId');

      if (!dataInicio || !dataFim) {
        return errorResponse('Data início e fim são obrigatórias', 400);
      }

      const colaboradorIdNum = colaboradorIdParam ? parseInt(colaboradorIdParam, 10) : null;
      let colaboradorIdsPermitidos: number[] | null = null;

      if (!isSuperAdmin(user) && user.userId > 0) {
        if (colaboradorIdNum != null) {
          const acesso = await resolverColaboradorIdComAcesso(user, colaboradorIdNum);
          if (!acesso.permitido) {
            return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
          }
        } else {
          const escopo = await obterEscopoGestor(user.userId);
          colaboradorIdsPermitidos = await listarColaboradoresNoEscopo(escopo);
          if (!colaboradorIdsPermitidos.includes(user.userId)) {
            colaboradorIdsPermitidos.push(user.userId);
          }
        }
      }

      // Construir filtros
      const conditions: string[] = ['c.status = $1'];
      const params: unknown[] = ['ativo'];
      let paramIndex = 2;

      if (colaboradorIdNum != null) {
        conditions.push(`c.id = $${paramIndex}`);
        params.push(colaboradorIdNum);
        paramIndex++;
      } else if (colaboradorIdsPermitidos != null) {
        conditions.push(`c.id = ANY($${paramIndex}::int[])`);
        params.push(colaboradorIdsPermitidos);
        paramIndex++;
      }

      if (departamentoId) {
        conditions.push(`c.departamento_id = $${paramIndex}`);
        params.push(parseInt(departamentoId));
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Buscar colaboradores
      const colaboradoresResult = await query(
        `SELECT c.id, c.nome, d.nome as departamento
         FROM people.colaboradores c
         LEFT JOIN departamentos d ON c.departamento_id = d.id
         ${whereClause}
         ORDER BY c.nome`,
        params
      );

      const colaboradores = [];

      for (const colab of colaboradoresResult.rows) {
        // Buscar marcações do colaborador no período
        const marcacoesResult = await query(
          `SELECT DATE(data_hora) as data, data_hora, tipo
           FROM people.marcacoes
           WHERE colaborador_id = $1 
           AND data_hora >= $2 
           AND data_hora <= $3::date + interval '1 day'
           ORDER BY data_hora`,
          [colab.id, dataInicio, dataFim]
        );

        // Agrupar por dia
        const diasMap = new Map<string, { marcacoes: Array<{ tipo: string; hora: string; status: string }>; horasTrabalhadas: string }>();

        for (const m of marcacoesResult.rows) {
          const dataStr = m.data.toISOString().split('T')[0];
          if (!diasMap.has(dataStr)) {
            diasMap.set(dataStr, { marcacoes: [], horasTrabalhadas: '00:00' });
          }
          diasMap.get(dataStr)!.marcacoes.push({
            tipo: m.tipo,
            hora: new Date(m.data_hora).toTimeString().substring(0, 5),
            status: 'registrado',
          });
        }

        const dias = Array.from(diasMap.entries()).map(([data, info]) => ({
          data,
          diaSemana: getDayName(new Date(data).getDay()),
          marcacoes: info.marcacoes,
          horasTrabalhadas: info.horasTrabalhadas,
          horasExtras: '00:00',
          observacoes: '',
        }));

        colaboradores.push({
          id: colab.id,
          nome: colab.nome,
          departamento: colab.departamento,
          dias,
          totalizadores: {
            diasTrabalhados: dias.length,
            horasTotais: 0,
            horasExtras: 0,
            faltas: 0,
            atrasos: 0,
          },
        });
      }

      return successResponse({
        periodo: { inicio: dataInicio, fim: dataFim },
        geradoEm: formatDateBR(new Date()),
        colaboradores,
      });
    } catch (error) {
      console.error('Erro ao gerar espelho de ponto:', error);
      return serverErrorResponse('Erro ao gerar relatório');
    }
  });
}
