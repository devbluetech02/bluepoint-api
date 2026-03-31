import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { paginatedSuccessResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function GET(request: NextRequest) {
  return withGestor(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const pagina = parseInt(searchParams.get('pagina') || '1');
      const limite = parseInt(searchParams.get('limite') || '50');
      const status = searchParams.get('status');
      const empresaId = searchParams.get('empresaId');
      const busca = searchParams.get('busca');

      const offset = (pagina - 1) * limite;

      // Gerar chave de cache
      const cacheKey = buildListCacheKey(CACHE_KEYS.DISPOSITIVOS, { pagina, limite, status, empresaId, busca });

      const resultado = await cacheAside(cacheKey, async () => {
        // Construir WHERE
        const conditions: string[] = [];
        const params: (string | number)[] = [];
        let paramIndex = 1;

        if (status) {
          conditions.push(`d.status = $${paramIndex++}`);
          params.push(status);
        }

        if (empresaId) {
          conditions.push(`d.empresa_id = $${paramIndex++}`);
          params.push(parseInt(empresaId));
        }

        if (busca) {
          conditions.push(`(d.nome ILIKE $${paramIndex} OR d.codigo ILIKE $${paramIndex})`);
          params.push(`%${busca}%`);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Contar total
        const countResult = await query(
          `SELECT COUNT(*) FROM people.dispositivos d ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        // Buscar dispositivos
        const result = await query(
          `SELECT 
            d.id, d.codigo, d.nome, d.descricao, d.status,
            d.permite_entrada, d.permite_saida, d.requer_foto, d.requer_geolocalizacao,
            d.modelo, d.sistema_operacional, d.versao_app,
            d.ultimo_acesso, d.ip_ultimo_acesso, d.total_registros,
            d.criado_em, d.atualizado_em,
            e.id as empresa_id, e.nome_fantasia as empresa_nome,
            l.id as localizacao_id, l.nome as localizacao_nome
          FROM people.dispositivos d
          LEFT JOIN people.empresas e ON d.empresa_id = e.id
          LEFT JOIN people.localizacoes l ON d.localizacao_id = l.id
          ${whereClause}
          ORDER BY d.criado_em DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          [...params, limite, offset]
        );

        const dispositivos = result.rows.map(d => ({
          id: d.id,
          codigo: d.codigo,
          nome: d.nome,
          descricao: d.descricao,
          status: d.status,
          permiteEntrada: d.permite_entrada,
          permiteSaida: d.permite_saida,
          requerFoto: d.requer_foto,
          requerGeolocalizacao: d.requer_geolocalizacao,
          modelo: d.modelo,
          sistemaOperacional: d.sistema_operacional,
          versaoApp: d.versao_app,
          ultimoAcesso: d.ultimo_acesso,
          ipUltimoAcesso: d.ip_ultimo_acesso,
          totalRegistros: d.total_registros,
          empresa: d.empresa_id ? {
            id: d.empresa_id,
            nome: d.empresa_nome,
          } : null,
          localizacao: d.localizacao_id ? {
            id: d.localizacao_id,
            nome: d.localizacao_nome,
          } : null,
          criadoEm: d.criado_em,
          atualizadoEm: d.atualizado_em,
        }));

        return {
          dispositivos,
          paginacao: {
            total,
            pagina,
            limite,
            totalPaginas: Math.ceil(total / limite),
          },
        };
      }, CACHE_TTL.MEDIUM);

      return paginatedSuccessResponse(
        resultado.dispositivos,
        resultado.paginacao.total,
        resultado.paginacao.pagina,
        resultado.paginacao.limite
      );

    } catch (error) {
      console.error('Erro ao listar dispositivos:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao listar dispositivos',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}
