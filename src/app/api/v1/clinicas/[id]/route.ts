import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  serverErrorResponse,
  validationErrorResponse,
  errorResponse,
} from '@/lib/api-response';
import { withAuth, withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

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

type ClinicaDbRow = ClinicaRow; // alias para fetch de validação

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

const FETCH_SQL = `
  SELECT
    c.id, c.nome, c.telefone,
    c.cep, c.logradouro, c.numero, c.complemento, c.bairro, c.cidade, c.estado,
    c.status, c.empresa_id, e.nome_fantasia AS empresa_nome,
    c.canal_agendamento, c.precisa_confirmacao, c.whatsapp_numero,
    c.site_agendamento_url, c.observacoes_agendamento, c.horario_atendimento,
    c.pix, c.criado_em, c.atualizado_em
  FROM people.clinicas c
  LEFT JOIN people.empresas e ON e.id = c.empresa_id
  WHERE c.id = $1
`;

// ── GET /api/v1/clinicas/[id] ────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const clinicaId = parseInt(id, 10);
      if (isNaN(clinicaId)) return notFoundResponse('Clínica não encontrada');

      const result = await query<ClinicaRow>(FETCH_SQL, [clinicaId]);
      if (result.rows.length === 0) return notFoundResponse('Clínica não encontrada');

      return successResponse(formatClinica(result.rows[0]));
    } catch (error) {
      console.error('Erro ao buscar clínica:', error);
      return serverErrorResponse('Erro ao buscar clínica');
    }
  });
}

// ── PUT /api/v1/clinicas/[id] ────────────────────────────────────────────────

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const clinicaId = parseInt(id, 10);
      if (isNaN(clinicaId)) return notFoundResponse('Clínica não encontrada');

      const existingResult = await query<ClinicaDbRow>(
        `SELECT canal_agendamento, precisa_confirmacao, whatsapp_numero, site_agendamento_url
         FROM people.clinicas WHERE id = $1`,
        [clinicaId]
      );
      if (existingResult.rows.length === 0) return notFoundResponse('Clínica não encontrada');
      const existing = existingResult.rows[0];

      const body = await req.json();
      const errors: Record<string, string[]> = {};

      if (body?.nome !== undefined && (typeof body.nome !== 'string' || !body.nome.trim())) {
        errors.nome = ['"nome" não pode ser vazio'];
      }
      if (body?.empresaId !== undefined && body.empresaId !== null) {
        if (!Number.isInteger(body.empresaId) || body.empresaId <= 0) errors.empresaId = ['"empresaId" deve ser inteiro positivo'];
      }
      if (body?.status !== undefined && !['ativa', 'inativa'].includes(body.status)) {
        errors.status = ['"status" deve ser "ativa" ou "inativa"'];
      }
      if (body?.estado !== undefined && body.estado !== null && String(body.estado).trim().length > 2) {
        errors.estado = ['"estado" deve ter no máximo 2 caracteres'];
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

      // Validações cruzadas: usa valor novo se enviado, senão usa o atual do banco
      const canalFinal = body?.canalAgendamento !== undefined ? body.canalAgendamento : existing.canal_agendamento;
      const whatsappFinal = body?.whatsappNumero !== undefined ? body.whatsappNumero : existing.whatsapp_numero;
      const urlFinal = body?.siteAgendamentoUrl !== undefined ? body.siteAgendamentoUrl : existing.site_agendamento_url;
      const confFinal = body?.precisaConfirmacao !== undefined ? body.precisaConfirmacao : existing.precisa_confirmacao;
      validarCamposCanal(canalFinal, whatsappFinal, urlFinal, confFinal, errors);

      if (Object.keys(errors).length > 0) return validationErrorResponse(errors);

      if (body?.empresaId) {
        const r = await query('SELECT id FROM people.empresas WHERE id = $1', [body.empresaId]);
        if (r.rows.length === 0) return errorResponse('Empresa não encontrada', 404);
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      const add = (col: string, val: unknown) => { fields.push(`${col} = $${idx++}`); values.push(val); };

      if (body?.nome !== undefined)               add('nome', String(body.nome).trim());
      if (body?.empresaId !== undefined)          add('empresa_id', body.empresaId ?? null);
      if (body?.telefone !== undefined)           add('telefone', body.telefone ? String(body.telefone).trim() : null);
      if (body?.cep !== undefined)                add('cep', body.cep ? String(body.cep).trim() : null);
      if (body?.logradouro !== undefined)         add('logradouro', body.logradouro ? String(body.logradouro).trim() : null);
      if (body?.numero !== undefined)             add('numero', body.numero ? String(body.numero).trim() : null);
      if (body?.complemento !== undefined)        add('complemento', body.complemento ? String(body.complemento).trim() : null);
      if (body?.bairro !== undefined)             add('bairro', body.bairro ? String(body.bairro).trim() : null);
      if (body?.cidade !== undefined)             add('cidade', body.cidade ? String(body.cidade).trim() : null);
      if (body?.estado !== undefined)             add('estado', body.estado ? String(body.estado).trim().toUpperCase() : null);
      if (body?.status !== undefined)             add('status', body.status);
      if (body?.canalAgendamento !== undefined)   add('canal_agendamento', body.canalAgendamento ?? null);
      if (body?.precisaConfirmacao !== undefined || body?.canalAgendamento === 'site') {
        add('precisa_confirmacao', body.canalAgendamento === 'site' ? true : body.precisaConfirmacao);
      }
      if (body?.whatsappNumero !== undefined)     add('whatsapp_numero', body.whatsappNumero ? String(body.whatsappNumero).replace(/\D/g, '') : null);
      if (body?.siteAgendamentoUrl !== undefined) add('site_agendamento_url', body.siteAgendamentoUrl ? String(body.siteAgendamentoUrl).trim() : null);
      if (body?.observacoesAgendamento !== undefined) add('observacoes_agendamento', body.observacoesAgendamento ? String(body.observacoesAgendamento).trim() : null);
      if (body?.horarioAtendimento !== undefined) add('horario_atendimento', body.horarioAtendimento ? JSON.stringify(body.horarioAtendimento) : null);
      if (body?.pix !== undefined)               add('pix', body.pix ? String(body.pix).trim() : null);

      if (fields.length === 0) return errorResponse('Nenhum campo enviado para atualização', 400);

      values.push(clinicaId);
      await query(`UPDATE people.clinicas SET ${fields.join(', ')} WHERE id = $${idx}`, values);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar', modulo: 'clinicas',
        descricao: `Clínica id=${clinicaId} atualizada`,
        entidadeId: clinicaId, entidadeTipo: 'clinica',
        dadosNovos: body,
      }));

      const updated = await query<ClinicaRow>(FETCH_SQL, [clinicaId]);
      return successResponse(formatClinica(updated.rows[0]));
    } catch (error) {
      console.error('Erro ao atualizar clínica:', error);
      return serverErrorResponse('Erro ao atualizar clínica');
    }
  });
}

// ── DELETE /api/v1/clinicas/[id] ─────────────────────────────────────────────

export async function DELETE(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const clinicaId = parseInt(id, 10);
      if (isNaN(clinicaId)) return notFoundResponse('Clínica não encontrada');

      const result = await query(
        `UPDATE people.clinicas SET status = 'inativa' WHERE id = $1 AND status = 'ativa' RETURNING id, nome`,
        [clinicaId]
      );

      if (result.rows.length === 0) {
        const exists = await query('SELECT id FROM people.clinicas WHERE id = $1', [clinicaId]);
        if (exists.rows.length === 0) return notFoundResponse('Clínica não encontrada');
        return errorResponse('Clínica já está inativa', 400);
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'deletar', modulo: 'clinicas',
        descricao: `Clínica "${result.rows[0].nome}" desativada`,
        entidadeId: clinicaId, entidadeTipo: 'clinica',
        dadosNovos: { status: 'inativa' },
      }));

      return successResponse({ id: clinicaId, status: 'inativa' });
    } catch (error) {
      console.error('Erro ao desativar clínica:', error);
      return serverErrorResponse('Erro ao desativar clínica');
    }
  });
}
