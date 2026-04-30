import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse, serverErrorResponse, getPaginationParams, getOrderParams } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { getDiasDescontoPorColaborador } from '@/lib/beneficios-desconto';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { isSuperAdmin, resolveNivelFromColaborador } from '@/lib/auth';
import { obterEscopoGestor } from '@/lib/escopo-gestor';
import { NIVEL_ADMIN, NIVEL_GESTOR } from '@/lib/niveis';

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const { orderBy, orderDir } = getOrderParams(searchParams, ['nome', 'email', 'data_admissao', 'criado_em']);

      const busca = searchParams.get('busca');
      const departamentoId = searchParams.get('filtro[departamentoId]');
      const status = searchParams.get('filtro[status]');
      const mesReferencia = searchParams.get('filtro[mesReferencia]'); // "YYYY-MM" opcional

      // Resolver escopo do solicitante:
      //  - super admin / API key → vê todos
      //  - nivelId >= 3 (admin)  → vê todos
      //  - nivelId === 2 (gestor) → restrito a departamentos/empresas do escopo
      //  - nivelId <= 1 (colaborador) → só o próprio cadastro
      const isSuper = isSuperAdmin(user);
      const isApiKey = user.userId < 0;
      const nivelId = typeof user.nivelId === 'number'
        ? user.nivelId
        : (isApiKey ? null : await resolveNivelFromColaborador(user.userId));
      const escopoGlobal = isSuper || isApiKey || (nivelId !== null && nivelId >= NIVEL_ADMIN);

      let escopoIdsColaboradores: number[] | null = null;
      if (!escopoGlobal) {
        if (nivelId === NIVEL_GESTOR) {
          const escopo = await obterEscopoGestor(user.userId);
          // Gestor sempre vê pelo menos a si próprio.
          const ids = new Set<number>([user.userId]);
          if (escopo.departamentoIds.length > 0 || escopo.empresaIds.length > 0) {
            const r = await query<{ id: number }>(
              `SELECT id FROM people.colaboradores
                WHERE departamento_id = ANY($1::int[])
                   OR empresa_id = ANY($2::int[])`,
              [escopo.departamentoIds, escopo.empresaIds],
            );
            for (const row of r.rows) ids.add(row.id);
          }
          escopoIdsColaboradores = Array.from(ids);
        } else {
          // Nível 1 (ou desconhecido) — só vê a si.
          escopoIdsColaboradores = [user.userId];
        }
      }

      // Cache por usuário quando há filtro de escopo (evita poluição cross-user).
      const cacheKey = buildListCacheKey(CACHE_KEYS.COLABORADORES, {
        pagina, limite, orderBy, orderDir, busca, departamentoId, status,
        mesReferencia: mesReferencia ?? '',
        escopo: escopoGlobal ? 'global' : `u${user.userId}`,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        // Construir query com filtros
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (busca) {
          conditions.push(`(c.nome ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.cpf ILIKE $${paramIndex})`);
          params.push(`%${busca}%`);
          paramIndex++;
        }

        if (departamentoId) {
          conditions.push(`c.departamento_id = $${paramIndex}`);
          params.push(parseInt(departamentoId));
          paramIndex++;
        }

        if (status) {
          conditions.push(`c.status = $${paramIndex}`);
          params.push(status);
          paramIndex++;
        }

        if (escopoIdsColaboradores !== null) {
          if (escopoIdsColaboradores.length === 0) {
            return { dados: [], total: 0, pagina, limite };
          }
          conditions.push(`c.id = ANY($${paramIndex}::int[])`);
          params.push(escopoIdsColaboradores);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) as total FROM people.colaboradores c ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        // Buscar dados
        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT
            c.id,
            c.nome,
            c.email,
            c.cpf,
            c.tipo,
            c.cargo_id,
            cg.nome as cargo_nome,
            c.status,
            c.foto_url,
            c.data_admissao,
            c.criado_em,
            c.atualizado_em,
            c.empresa_id,
            c.vale_alimentacao,
            c.vale_transporte,
            d.id as departamento_id,
            d.nome as departamento_nome,
            j.id as jornada_id,
            j.nome as jornada_nome,
            e.nome_fantasia as empresa_nome_fantasia,
            CASE WHEN bf.id IS NOT NULL THEN true ELSE false END as tem_biometria,
            bf.data_cadastro as biometria_cadastrada_em
          FROM people.colaboradores c
          LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
          LEFT JOIN people.departamentos d ON c.departamento_id = d.id
          LEFT JOIN people.jornadas j ON c.jornada_id = j.id
          LEFT JOIN people.empresas e ON c.empresa_id = e.id
          LEFT JOIN people.biometria_facial bf ON c.id = bf.colaborador_id
          ${whereClause}
          ORDER BY c.${orderBy} ${orderDir}
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          dataParams
        );

        let diasDescontoMap: Map<number, number> = new Map();
        let mesRefBeneficios: string | null = null;
        if (mesReferencia && /^\d{4}-\d{2}$/.test(mesReferencia)) {
          const [anoStr, mesStr] = mesReferencia.split('-');
          const ano = parseInt(anoStr, 10);
          const mes = parseInt(mesStr, 10);
          if (ano >= 2020 && ano <= 2100 && mes >= 1 && mes <= 12) {
            mesRefBeneficios = mesReferencia;
            const parametrosRes = await query(
              `SELECT horas_minimas_para_vale_alimentacao FROM people.parametros_beneficios ORDER BY id DESC LIMIT 1`
            );
            const horasMin = parametrosRes.rows[0]
              ? Number(parametrosRes.rows[0].horas_minimas_para_vale_alimentacao)
              : 6;
            const idsAtivos = result.rows
              .filter(r => (r as { status: string }).status === 'ativo')
              .map(r => Number((r as { id: number }).id));
            diasDescontoMap = await getDiasDescontoPorColaborador(ano, mes, idsAtivos, horasMin);
          }
        }

        const dados = result.rows.map(row => {
          const item: Record<string, unknown> = {
            id: row.id,
            nome: row.nome,
            email: row.email,
            cpf: row.cpf,
            matricula: row.cpf ?? null,
            empresa: row.empresa_id ? { id: row.empresa_id, nomeFantasia: row.empresa_nome_fantasia } : null,
            departamento: row.departamento_id ? { id: row.departamento_id, nome: row.departamento_nome } : null,
            jornada: row.jornada_id ? { id: row.jornada_id, nome: row.jornada_nome } : null,
            cargo: row.cargo_id ? { id: row.cargo_id, nome: row.cargo_nome } : null,
            tipo: row.tipo ?? 'colaborador',
            dataAdmissao: row.data_admissao,
            criadoEm: row.criado_em,
            atualizadoEm: row.atualizado_em,
            status: row.status,
            foto: row.foto_url,
            valeAlimentacao: row.vale_alimentacao === true,
            valeTransporte: row.vale_transporte === true,
            biometria: {
              cadastrada: row.tem_biometria,
              cadastradaEm: row.biometria_cadastrada_em || null,
            },
          };
          if (mesRefBeneficios) {
            item.diasDesconto = diasDescontoMap.get(Number(row.id)) ?? 0;
            item.mesReferenciaBeneficios = mesRefBeneficios;
          }
          return item;
        });

        return { dados, total, pagina, limite };
      }, CACHE_TTL.SHORT);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'visualizar',
        modulo: 'usuarios',
        descricao: 'Listagem de colaboradores',
      }));

      return paginatedSuccessResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
    } catch (error) {
      console.error('Erro ao listar colaboradores:', error);
      return serverErrorResponse('Erro ao listar colaboradores');
    }
  });
}
