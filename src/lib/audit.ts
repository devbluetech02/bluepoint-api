import { query } from './db';
import { embedTableRowAfterInsert } from './embeddings';

export type AuditAction = 
  | 'login'
  | 'logout'
  | 'criar'
  | 'editar'
  | 'excluir'
  | 'visualizar'
  | 'exportar'
  | 'aprovar'
  | 'rejeitar'
  // Aliases legados (aceitos para compatibilidade)
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'APPROVE'
  | 'REJECT'
  | 'EXPORT';

export type AuditModule = 
  | 'auth'
  | 'usuarios'
  | 'configuracoes'
  | 'marcacoes'
  | 'solicitacoes'
  | 'relatorios'
  | 'empresas'
  | 'cargos'
  | 'departamentos'
  | 'horarios'
  | 'feriados'
  | 'dispositivos'
  | 'dashboard'
  | 'beneficios'
  | 'alertas'
  | 'permissoes'
  | 'auditoria'
  // Módulos legados / específicos
  | 'autenticacao'
  | 'colaboradores'
  | 'jornadas'
  | 'banco_horas'
  | 'localizacoes'
  | 'notificacoes'
  | 'integracao'
  | 'biometria'
  | 'api_keys'
  | 'apps'
  | 'horas_extras'
  | 'custos_horas_extras'
  | 'limites_he_gestores'
  | 'limites_he_empresas'
  | 'limites_he_departamentos'
  | 'liderancas_departamento'
  | 'anexos'
  | 'cache'
  | 'geofence'
  | 'registro_ponto'
  | 'tokens'
  | 'ferias'
  | 'exportacao'
  | 'assiduidade'
  | 'prestadores'
  | 'contratos_prestador'
  | 'nfes_prestador'
  | 'gestao_pessoas';

export interface AuditLogParams {
  usuarioId?: number | null;
  usuarioNome?: string;
  usuarioEmail?: string;
  acao: AuditAction;
  modulo: AuditModule;
  descricao: string;
  ip?: string;
  userAgent?: string;
  entidadeId?: number | null;
  entidadeTipo?: string;
  colaboradorId?: number | null;
  colaboradorNome?: string;
  dadosAnteriores?: Record<string, unknown>;
  dadosNovos?: Record<string, unknown>;
  metadados?: Record<string, unknown>;
}

/** Usuário mínimo para contexto de auditoria (ex.: JWTPayload) */
export interface AuditContextUser {
  userId: number;
  nome: string;
  email?: string;
}

/**
 * Monta parâmetros completos de auditoria a partir do request e do usuário.
 * Preenche ip, userAgent, usuarioId, usuarioNome, usuarioEmail automaticamente.
 */
export function buildAuditParams(
  request: Request,
  user: AuditContextUser,
  params: Omit<AuditLogParams, 'usuarioId' | 'usuarioNome' | 'usuarioEmail' | 'ip' | 'userAgent'>
): AuditLogParams {
  return {
    usuarioId: user.userId,
    usuarioNome: user.nome,
    usuarioEmail: user.email,
    ip: getClientIp(request),
    userAgent: getUserAgent(request),
    ...params,
  };
}

export async function registrarAuditoria(params: AuditLogParams): Promise<void> {
  try {
    const result = await query(
      `INSERT INTO bt_auditoria 
        (usuario_id, acao, modulo, descricao, ip, user_agent,
         dados_anteriores, dados_novos, metadados,
         entidade_id, entidade_tipo, colaborador_id, colaborador_nome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        params.usuarioId || null,
        params.acao,
        params.modulo,
        params.descricao,
        params.ip || null,
        params.userAgent || null,
        params.dadosAnteriores ? JSON.stringify(params.dadosAnteriores) : null,
        params.dadosNovos ? JSON.stringify(params.dadosNovos) : null,
        params.metadados ? JSON.stringify(params.metadados) : null,
        params.entidadeId || null,
        params.entidadeTipo || null,
        params.colaboradorId || null,
        params.colaboradorNome || null,
      ]
    );
    const id = result.rows[0]?.id;
    if (id != null) {
      embedTableRowAfterInsert('bt_auditoria', id).catch(() => {});
    }
  } catch (error) {
    console.error('Erro ao registrar auditoria:', error);
  }
}

export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }
  return 'unknown';
}

export function getUserAgent(request: Request): string {
  return request.headers.get('user-agent') || 'unknown';
}
