import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  createdResponse,
  serverErrorResponse,
  validationErrorResponse,
  errorResponse,
} from '@/lib/api-response';
import { withAuth, withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

// ── Tipos ────────────────────────────────────────────────────────────────────

type HorarioDia = { aberto: false } | { aberto: true; abre: string; fecha: string };
type HorarioAtendimento = Partial<Record<'seg' | 'ter' | 'qua' | 'qui' | 'sex' | 'sab' | 'dom', HorarioDia>>;

type ClinicaRow = {
  id: number;
  nome: string;
  telefone: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  status: string;
  empresa_id: number | null;
  empresa_nome: string | null;
  canal_agendamento: string | null;
  precisa_confirmacao: boolean;
  whatsapp_numero: string | null;
  site_agendamento_url: string | null;
  observacoes_agendamento: string | null;
  horario_atendimento: HorarioAtendimento | null;
  pix: string | null;
  criado_em: string;
  atualizado_em: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'] as const;

function validarHorarioAtendimento(horario: unknown): string | null {
  if (typeof horario !== 'object' || horario === null || Array.isArray(horario)) {
    return '"horarioAtendimento" deve ser um objeto';
  }
  const h = horario as Record<string, unknown>;
  for (const dia of DIAS) {
    if (!(dia in h)) continue;
    const d = h[dia] as Record<string, unknown>;
    if (typeof d !== 'object' || d === null) return `horarioAtendimento.${dia} inválido`;
    if (typeof d.aberto !== 'boolean') return `horarioAtendimento.${dia}.aberto deve ser boolean`;
    if (d.aberto) {
      if (typeof d.abre !== 'string' || !HORA_RE.test(d.abre)) return `horarioAtendimento.${dia}.abre deve ser HH:mm`;
      if (typeof d.fecha !== 'string' || !HORA_RE.test(d.fecha)) return `horarioAtendimento.${dia}.fecha deve ser HH:mm`;
      if (d.abre >= d.fecha) return `horarioAtendimento.${dia}: abre deve ser antes de fecha`;
    }
  }
  return null;
}

function validarCamposCanal(
  canal: string | null | undefined,
  whatsapp: string | null | undefined,
  siteUrl: string | null | undefined,
  precisaConf: boolean | null | undefined,
  errors: Record<string, string[]>,
) {
  if (canal === 'whatsapp') {
    const num = String(whatsapp ?? '').replace(/\D/g, '');
    if (num.length < 10) errors.whatsappNumero = ['"whatsappNumero" é obrigatório e deve ter mínimo 10 dígitos quando canal="whatsapp"'];
  }
  if (canal === 'site') {
    if (!siteUrl?.trim()) errors.siteAgendamentoUrl = ['"siteAgendamentoUrl" é obrigatório quando canal="site"'];
    if (precisaConf === false) errors.precisaConfirmacao = ['"precisaConfirmacao" deve ser true quando canal="site"'];
  }
}

function formatClinica(row: ClinicaRow) {
  return {
    id: row.id,
    nome: row.nome,
    telefone: row.telefone,
    endereco: {
      cep: row.cep,
      logradouro: row.logradouro,
      numero: row.numero,
      complemento: row.complemento,
      bairro: row.bairro,
      cidade: row.cidade,
      estado: row.estado,
    },
    status: row.status,
    empresa: row.empresa_id ? { id: row.empresa_id, nome: row.empresa_nome } : null,
    canalAgendamento: row.canal_agendamento,
    precisaConfirmacao: row.precisa_confirmacao,
    whatsappNumero: row.whatsapp_numero,
    siteAgendamentoUrl: row.site_agendamento_url,
    observacoesAgendamento: row.observacoes_agendamento,
    horarioAtendimento: row.horario_atendimento,
    pix: row.pix,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const SELECT_SQL = `
  SELECT
    c.id, c.nome, c.telefone,
    c.cep, c.logradouro, c.numero, c.complemento, c.bairro, c.cidade, c.estado,
    c.status, c.empresa_id, e.nome_fantasia AS empresa_nome,
    c.canal_agendamento, c.precisa_confirmacao, c.whatsapp_numero,
    c.site_agendamento_url, c.observacoes_agendamento, c.horario_atendimento,
    c.pix, c.criado_em, c.atualizado_em
  FROM people.clinicas c
  LEFT JOIN people.empresas e ON e.id = c.empresa_id
`;

// ── GET /api/v1/clinicas ─────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const sp = request.nextUrl.searchParams;
      const empresaId = sp.get('empresa_id');
      const status = sp.get('status') ?? 'ativa';

      const params: unknown[] = [status];
      const wheres = ['c.status = $1'];

      if (empresaId) {
        const eid = parseInt(empresaId, 10);
        if (isNaN(eid)) return errorResponse('empresa_id deve ser um número', 400);
        wheres.push(`c.empresa_id = $2`);
        params.push(eid);
      }

      const sql = `${SELECT_SQL} WHERE ${wheres.join(' AND ')} ORDER BY c.nome ASC`;
      const result = await query<ClinicaRow>(sql, params);

      return successResponse({ clinicas: result.rows.map(formatClinica) });
    } catch (error) {
      console.error('Erro ao listar clínicas:', error);
      return serverErrorResponse('Erro ao listar clínicas');
    }
  });
}

// ── POST /api/v1/clinicas ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      const errors: Record<string, string[]> = {};

      if (typeof body?.nome !== 'string' || !body.nome.trim()) {
        errors.nome = ['"nome" é obrigatório'];
      }
      if (body?.empresaId !== undefined && (!Number.isInteger(body.empresaId) || body.empresaId <= 0)) {
        errors.empresaId = ['"empresaId" deve ser um ID inteiro positivo'];
      }
      if (body?.estado !== undefined && body.estado !== null && String(body.estado).trim().length > 2) {
        errors.estado = ['"estado" deve ter no máximo 2 caracteres (ex: "GO")'];
      }
      if (body?.canalAgendamento !== undefined && !['whatsapp', 'site'].includes(body.canalAgendamento)) {
        errors.canalAgendamento = ['"canalAgendamento" deve ser "whatsapp" ou "site"'];
      }
      if (body?.precisaConfirmacao !== undefined && typeof body.precisaConfirmacao !== 'boolean') {
        errors.precisaConfirmacao = ['"precisaConfirmacao" deve ser boolean'];
      }
      if (body?.horarioAtendimento !== undefined) {
        const err = validarHorarioAtendimento(body.horarioAtendimento);
        if (err) errors.horarioAtendimento = [err];
      }

      // Validações cruzadas de canal
      validarCamposCanal(
        body?.canalAgendamento,
        body?.whatsappNumero,
        body?.siteAgendamentoUrl,
        body?.precisaConfirmacao,
        errors,
      );

      if (Object.keys(errors).length > 0) return validationErrorResponse(errors);

      const nome        = String(body.nome).trim();
      const empresaId   = body.empresaId ?? null;
      const canal       = body.canalAgendamento ?? null;
      // canal=site força precisaConfirmacao=true
      const precisaConf = canal === 'site' ? true : (body.precisaConfirmacao ?? false);

      if (empresaId) {
        const r = await query('SELECT id FROM people.empresas WHERE id = $1', [empresaId]);
        if (r.rows.length === 0) return errorResponse('Empresa não encontrada', 404);
      }

      const insertResult = await query(
        `INSERT INTO people.clinicas (
           nome, empresa_id, telefone, cep, logradouro, numero, complemento,
           bairro, cidade, estado,
           canal_agendamento, precisa_confirmacao, whatsapp_numero,
           site_agendamento_url, observacoes_agendamento, horario_atendimento, pix
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [
          nome,
          empresaId,
          body.telefone   ? String(body.telefone).trim()          : null,
          body.cep        ? String(body.cep).trim()               : null,
          body.logradouro ? String(body.logradouro).trim()        : null,
          body.numero     ? String(body.numero).trim()            : null,
          body.complemento ? String(body.complemento).trim()      : null,
          body.bairro     ? String(body.bairro).trim()            : null,
          body.cidade     ? String(body.cidade).trim()            : null,
          body.estado     ? String(body.estado).trim().toUpperCase() : null,
          canal,
          precisaConf,
          body.whatsappNumero ? String(body.whatsappNumero).replace(/\D/g, '') : null,
          body.siteAgendamentoUrl ? String(body.siteAgendamentoUrl).trim() : null,
          body.observacoesAgendamento ? String(body.observacoesAgendamento).trim() : null,
          body.horarioAtendimento ? JSON.stringify(body.horarioAtendimento) : null,
          body.pix ? String(body.pix).trim() : null,
        ]
      );

      const clinicaId: number = insertResult.rows[0].id;

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'criar', modulo: 'clinicas',
        descricao: `Clínica "${nome}" criada`,
        entidadeId: clinicaId, entidadeTipo: 'clinica',
        dadosNovos: { id: clinicaId, nome, empresaId, canal },
      }));

      const fetch = await query<ClinicaRow>(`${SELECT_SQL} WHERE c.id = $1`, [clinicaId]);
      return createdResponse(formatClinica(fetch.rows[0]));
    } catch (error) {
      console.error('Erro ao criar clínica:', error);
      return serverErrorResponse('Erro ao criar clínica');
    }
  });
}
