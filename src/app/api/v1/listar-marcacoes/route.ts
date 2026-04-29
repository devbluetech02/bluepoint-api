import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, forbiddenResponse, serverErrorResponse, getPaginationParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { resolverColaboradorIdComAcesso, obterEscopoGestor, listarColaboradoresNoEscopo } from '@/lib/escopo-gestor';
import { isSuperAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const colaboradorIdParam = searchParams.get('colaboradorId');
      const dataInicio = searchParams.get('dataInicio');
      const dataFim = searchParams.get('dataFim');
      const tipo = searchParams.get('tipo');
      const departamentoId = searchParams.get('filtro[departamentoId]');

      // Resolver escopo do caller — colaborador comum só vê o próprio;
      // gestor vê o escopo (próprio + atribuídos); super admin / API Key
      // veem tudo (não filtra).
      const colaboradorIdNum = colaboradorIdParam ? parseInt(colaboradorIdParam, 10) : null;
      let colaboradorIdsPermitidos: number[] | null = null; // null = sem restrição (admin)

      if (!isSuperAdmin(user) && user.userId > 0) {
        if (colaboradorIdNum != null) {
          // Pediu colaborador específico → valida acesso pontual.
          const acesso = await resolverColaboradorIdComAcesso(user, colaboradorIdNum);
          if (!acesso.permitido) {
            return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
          }
        } else {
          // Sem param → restringe pelo escopo (próprio + gestão atribuída).
          const escopo = await obterEscopoGestor(user.userId);
          colaboradorIdsPermitidos = await listarColaboradoresNoEscopo(escopo);
          // Garantia: o próprio sempre incluído (mesmo se não estiver
          // ativo ou não tiver dept).
          if (!colaboradorIdsPermitidos.includes(user.userId)) {
            colaboradorIdsPermitidos.push(user.userId);
          }
        }
      }

      // Cache key inclui o caller pra evitar cross-tenant cache hit
      const cacheScope = isSuperAdmin(user) || user.userId < 0
        ? 'admin'
        : (colaboradorIdNum != null ? `c${colaboradorIdNum}` : `u${user.userId}`);

      const cacheKey = buildListCacheKey(CACHE_KEYS.MARCACOES, {
        pagina, limite, colaboradorId: colaboradorIdParam, dataInicio, dataFim, tipo, departamentoId, scope: cacheScope,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        // Construir query com filtros
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (colaboradorIdNum != null) {
          conditions.push(`m.colaborador_id = $${paramIndex}`);
          params.push(colaboradorIdNum);
          paramIndex++;
        } else if (colaboradorIdsPermitidos != null) {
          // Restringe ao escopo do gestor (ou apenas o próprio).
          conditions.push(`m.colaborador_id = ANY($${paramIndex}::int[])`);
          params.push(colaboradorIdsPermitidos);
          paramIndex++;
        }

        if (dataInicio) {
          conditions.push(`m.data_hora >= $${paramIndex}`);
          params.push(dataInicio);
          paramIndex++;
        }

        if (dataFim) {
          conditions.push(`m.data_hora <= $${paramIndex}::date + interval '1 day'`);
          params.push(dataFim);
          paramIndex++;
        }

        if (tipo) {
          conditions.push(`m.tipo = $${paramIndex}`);
          params.push(tipo);
          paramIndex++;
        }

        if (departamentoId) {
          conditions.push(`c.departamento_id = $${paramIndex}`);
          params.push(parseInt(departamentoId));
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total 
           FROM people.marcacoes m
           JOIN people.colaboradores c ON m.colaborador_id = c.id
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT 
            m.id,
            m.data_hora,
            m.tipo,
            m.latitude,
            m.longitude,
            m.endereco,
            m.metodo,
            m.foto_url,
            m.observacao,
            m.empresa_id,
            m.foi_ajustada,
            m.data_hora_original,
            m.ajustada_em,
            aj.id as ajustada_por_id,
            aj.nome as ajustada_por_nome,
            c.id as colaborador_id,
            c.nome as colaborador_nome,
            e.nome_fantasia as empresa_nome
          FROM people.marcacoes m
          JOIN people.colaboradores c ON m.colaborador_id = c.id
          LEFT JOIN people.empresas e ON m.empresa_id = e.id
          LEFT JOIN people.colaboradores aj ON m.ajustada_por = aj.id
          ${whereClause}
          ORDER BY m.data_hora DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        const dados = result.rows.map(row => ({
          id: row.id,
          colaborador: { id: row.colaborador_id, nome: row.colaborador_nome },
          empresa: row.empresa_id ? { id: row.empresa_id, nomeFantasia: row.empresa_nome } : null,
          dataHora: row.data_hora,
          tipo: row.tipo,
          localizacao: row.latitude ? {
            latitude: parseFloat(row.latitude),
            longitude: parseFloat(row.longitude),
            endereco: row.endereco,
          } : null,
          metodo: row.metodo,
          foto: row.foto_url,
          observacao: row.observacao,
          foiAjustada: row.foi_ajustada,
          ajuste: row.foi_ajustada ? {
            dataHoraOriginal: row.data_hora_original,
            ajustadaPor: row.ajustada_por_id ? { id: row.ajustada_por_id, nome: row.ajustada_por_nome } : null,
            ajustadaEm: row.ajustada_em,
          } : null,
        }));

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar marcações:', error);
      return serverErrorResponse('Erro ao listar marcações');
    }
  });
}
