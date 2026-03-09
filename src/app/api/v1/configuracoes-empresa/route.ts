import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { atualizarConfigSistemaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheAside, cacheDel, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

// =====================================================
// Defaults para criação automática
// =====================================================

const DEFAULTS = {
  geral: {
    nomeEmpresa: '',
    fusoHorario: 'America/Sao_Paulo',
    formatoData: 'DD/MM/YYYY',
    formatoHora: '24h',
    idioma: 'pt-BR',
  },
  ponto: {
    toleranciaEntrada: 10,
    toleranciaSaida: 10,
    intervaloMinimoMarcacoes: 1,
    permitirMarcacaoOffline: true,
    exigirFotoPadrao: true,
    exigirGeolocalizacaoPadrao: false,
    raioMaximoGeolocalizacao: 100,
    permitirMarcacaoForaPerimetro: false,
    bloquearMarcacaoDuplicada: true,
    tempoBloqueioDuplicada: 5,
  },
  notificacoes: {
    notificarAtrasos: true,
    notificarFaltasMarcacao: true,
    notificarHorasExtras: true,
    notificarAprovacoesPendentes: true,
    emailNotificacoes: true,
    pushNotificacoes: true,
    resumoDiario: false,
    horarioResumoDiario: '08:00',
  },
  seguranca: {
    tempoSessao: 480,
    exigirSenhaForte: true,
    tamanhoMinimoSenha: 8,
    exigirTrocaSenhaPeriodica: false,
    diasTrocaSenha: 90,
    tentativasLoginMax: 5,
    tempoBloqueioLogin: 15,
    autenticacaoDoisFatores: false,
  },
  aparencia: {
    tema: 'claro',
    corPrimaria: '#2563eb',
    mostrarLogoSidebar: true,
    compactarSidebar: false,
  },
};

// =====================================================
// Helper: buscar empresa_id do colaborador
// =====================================================

async function getEmpresaId(userId: number): Promise<number | null> {
  const result = await query<{ empresa_id: number }>(
    `SELECT empresa_id FROM bluepoint.bt_colaboradores WHERE id = $1`,
    [userId]
  );
  return result.rows[0]?.empresa_id ?? null;
}

// =====================================================
// Helper: buscar ou criar config com defaults
// =====================================================

async function getOrCreateConfig(empresaId: number) {
  // Tentar buscar config existente
  const existing = await query(
    `SELECT cs.id, cs.empresa_id, cs.geral, cs.ponto, cs.notificacoes, cs.seguranca, cs.aparencia,
            cs.atualizado_em, cs.atualizado_por,
            c.nome as atualizado_por_nome
     FROM bluepoint.bt_config_sistema cs
     LEFT JOIN bluepoint.bt_colaboradores c ON cs.atualizado_por = c.id
     WHERE cs.empresa_id = $1`,
    [empresaId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Criar com defaults se não existir
  const inserted = await query(
    `INSERT INTO bluepoint.bt_config_sistema (empresa_id, geral, ponto, notificacoes, seguranca, aparencia)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, empresa_id, geral, ponto, notificacoes, seguranca, aparencia, atualizado_em, atualizado_por`,
    [
      empresaId,
      JSON.stringify(DEFAULTS.geral),
      JSON.stringify(DEFAULTS.ponto),
      JSON.stringify(DEFAULTS.notificacoes),
      JSON.stringify(DEFAULTS.seguranca),
      JSON.stringify(DEFAULTS.aparencia),
    ]
  );

  return inserted.rows[0];
}

// =====================================================
// Helper: formatar resposta
// =====================================================

function formatResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    geral: row.geral,
    ponto: row.ponto,
    notificacoes: row.notificacoes,
    seguranca: row.seguranca,
    aparencia: row.aparencia,
    atualizadoEm: row.atualizado_em,
    atualizadoPor: row.atualizado_por
      ? { id: row.atualizado_por, nome: row.atualizado_por_nome || null }
      : null,
  };
}

// =====================================================
// GET /api/v1/configuracoes-empresa
// =====================================================

export async function GET(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const empresaId = await getEmpresaId(user.userId);
      if (!empresaId) {
        return errorResponse('Empresa não encontrada para este usuário', 404);
      }

      const cacheKey = `${CACHE_KEYS.CONFIGURACOES}sistema:${empresaId}`;

      const data = await cacheAside(
        cacheKey,
        async () => {
          const row = await getOrCreateConfig(empresaId);
          return formatResponse(row);
        },
        CACHE_TTL.LONG
      );

      return successResponse(data);
    } catch (error) {
      console.error('Erro ao buscar configurações da empresa:', error);
      return serverErrorResponse('Erro ao buscar configurações da empresa');
    }
  });
}

// =====================================================
// PUT /api/v1/configuracoes-empresa
// =====================================================

export async function PUT(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const empresaId = await getEmpresaId(user.userId);
      if (!empresaId) {
        return errorResponse('Empresa não encontrada para este usuário', 404);
      }

      const body = await req.json();

      const validation = validateBody(atualizarConfigSistemaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { geral, ponto, notificacoes, seguranca, aparencia } = validation.data;

      // Garantir que o registro existe (cria com defaults se necessário)
      await getOrCreateConfig(empresaId);

      // Montar SET dinâmico — só atualiza as seções enviadas
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (geral) {
        setClauses.push(`geral = $${paramIndex++}`);
        values.push(JSON.stringify(geral));
      }
      if (ponto) {
        setClauses.push(`ponto = $${paramIndex++}`);
        values.push(JSON.stringify(ponto));
      }
      if (notificacoes) {
        setClauses.push(`notificacoes = $${paramIndex++}`);
        values.push(JSON.stringify(notificacoes));
      }
      if (seguranca) {
        setClauses.push(`seguranca = $${paramIndex++}`);
        values.push(JSON.stringify(seguranca));
      }
      if (aparencia) {
        setClauses.push(`aparencia = $${paramIndex++}`);
        values.push(JSON.stringify(aparencia));
      }

      setClauses.push(`atualizado_por = $${paramIndex++}`);
      values.push(user.userId);

      setClauses.push(`atualizado_em = NOW()`);

      // empresa_id como último param
      values.push(empresaId);

      const updateResult = await query(
        `UPDATE bluepoint.bt_config_sistema
         SET ${setClauses.join(', ')}
         WHERE empresa_id = $${paramIndex}
         RETURNING id, empresa_id, geral, ponto, notificacoes, seguranca, aparencia, atualizado_em, atualizado_por`,
        values
      );

      if (updateResult.rows.length === 0) {
        return serverErrorResponse('Erro ao atualizar configurações');
      }

      const row = updateResult.rows[0];

      // Buscar nome do atualizador
      const userResult = await query<{ nome: string }>(
        `SELECT nome FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [user.userId]
      );

      row.atualizado_por_nome = userResult.rows[0]?.nome || null;

      // Invalidar cache
      const cacheKey = `${CACHE_KEYS.CONFIGURACOES}sistema:${empresaId}`;
      await cacheDel(cacheKey);

      // Registrar auditoria
      const secoesAlteradas = [
        geral && 'geral',
        ponto && 'ponto',
        notificacoes && 'notificacoes',
        seguranca && 'seguranca',
        aparencia && 'aparencia',
      ].filter(Boolean).join(', ');

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'configuracoes',
        descricao: `Configurações do sistema atualizadas: ${secoesAlteradas}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: validation.data as Record<string, unknown>,
      });

      return successResponse({
        ...formatResponse(row),
        mensagem: 'Configurações atualizadas com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar configurações da empresa:', error);
      return serverErrorResponse('Erro ao atualizar configurações da empresa');
    }
  });
}
