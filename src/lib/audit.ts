import { query } from './db';

export type AuditAction = 
  | 'CREATE' 
  | 'UPDATE' 
  | 'DELETE' 
  | 'LOGIN' 
  | 'LOGOUT' 
  | 'APPROVE' 
  | 'REJECT' 
  | 'EXPORT';

export type AuditModule = 
  | 'autenticacao' 
  | 'colaboradores' 
  | 'marcacoes' 
  | 'jornadas' 
  | 'banco_horas' 
  | 'solicitacoes' 
  | 'departamentos' 
  | 'localizacoes' 
  | 'feriados' 
  | 'notificacoes' 
  | 'configuracoes' 
  | 'relatorios' 
  | 'integracao'
  | 'empresas'
  | 'biometria'
  | 'cargos'
  | 'dispositivos'
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
  | 'beneficios'
  | 'ferias'
  | 'exportacao';

interface AuditLogParams {
  usuarioId?: number | null;
  acao: AuditAction;
  modulo: AuditModule;
  descricao: string;
  ip?: string;
  userAgent?: string;
  dadosAnteriores?: Record<string, unknown>;
  dadosNovos?: Record<string, unknown>;
  metadados?: Record<string, unknown>;
}

export async function registrarAuditoria(params: AuditLogParams): Promise<void> {
  try {
    await query(
      `INSERT INTO bt_auditoria 
        (usuario_id, acao, modulo, descricao, ip, user_agent, dados_anteriores, dados_novos, metadados)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
      ]
    );
  } catch (error) {
    console.error('Erro ao registrar auditoria:', error);
    // Não lançamos erro para não interromper a operação principal
  }
}

// Helper para extrair IP do request
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

// Helper para extrair User-Agent do request
export function getUserAgent(request: Request): string {
  return request.headers.get('user-agent') || 'unknown';
}
