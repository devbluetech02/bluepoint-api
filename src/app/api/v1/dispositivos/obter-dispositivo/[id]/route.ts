import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function GET(request: NextRequest, { params }: Params) {
  return withGestor(request, async () => {
    try {
      const { id } = await params;
      const dispositivoId = parseInt(id);

      if (isNaN(dispositivoId)) {
        return jsonResponse({
          success: false,
          error: 'ID inválido',
          code: 'INVALID_ID',
        }, 400);
      }

      const cacheKey = `${CACHE_KEYS.DISPOSITIVO}${dispositivoId}`;

      const cached = await cacheAside(cacheKey, async () => {
      const result = await query(
        `SELECT 
          d.id, d.codigo, d.nome, d.descricao, d.status,
          d.permite_entrada, d.permite_saida, d.requer_foto, d.requer_geolocalizacao,
          d.modelo, d.sistema_operacional, d.versao_app,
          d.ultimo_acesso, d.ip_ultimo_acesso, d.total_registros,
          d.criado_em, d.atualizado_em,
          d.criado_por,
          e.id as empresa_id, e.nome_fantasia as empresa_nome,
          l.id as localizacao_id, l.nome as localizacao_nome,
          c.nome as criado_por_nome
        FROM people.dispositivos d
        LEFT JOIN people.empresas e ON d.empresa_id = e.id
        LEFT JOIN people.localizacoes l ON d.localizacao_id = l.id
        LEFT JOIN people.colaboradores c ON d.criado_por = c.id
        WHERE d.id = $1`,
        [dispositivoId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const d = result.rows[0];

      return {
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
          criadoPor: d.criado_por ? {
            id: d.criado_por,
            nome: d.criado_por_nome,
          } : null,
          criadoEm: d.criado_em,
          atualizadoEm: d.atualizado_em,
        };
      }, CACHE_TTL.MEDIUM);

      if (!cached) {
        return jsonResponse({
          success: false,
          error: 'Dispositivo não encontrado',
          code: 'NOT_FOUND',
        }, 404);
      }

      return jsonResponse({
        success: true,
        data: cached,
      });

    } catch (error) {
      console.error('Erro ao obter dispositivo:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao obter dispositivo',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}
