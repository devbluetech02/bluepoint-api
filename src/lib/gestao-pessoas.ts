import { query } from './db';

// =====================================================
// CONSTANTES
// =====================================================

export const EXTENSOES_PERMITIDAS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp',
  'mp4', 'webm', 'mov', 'avi',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt',
]);

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// =====================================================
// HELPERS
// =====================================================

export function detectarTipoAnexo(extensao: string): string {
  const ext = extensao.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'imagem';
  if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
  return 'documento';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.substring(0, 10);
}

// =====================================================
// FORMATAÇÃO DE ANEXOS
// =====================================================

interface AnexoRow {
  id: number;
  gestao_pessoa_id: number;
  nome: string;
  tipo: string;
  tamanho: number;
  url: string;
  criado_em: string;
}

export function formatAnexo(row: AnexoRow) {
  return {
    id: row.id,
    nome: row.nome,
    tipo: row.tipo,
    tamanho: formatFileSize(row.tamanho),
    dataUpload: formatDateOnly(row.criado_em),
    url: row.url,
  };
}

// =====================================================
// BATCH DATA FETCHING
// =====================================================

export async function fetchAnexosPorRegistros(registroIds: number[]): Promise<Map<number, AnexoRow[]>> {
  if (registroIds.length === 0) return new Map();

  const placeholders = registroIds.map((_, i) => `$${i + 1}`).join(',');
  const result = await query(
    `SELECT id, gestao_pessoa_id, nome, tipo, tamanho, url, criado_em
     FROM bluepoint.bt_gestao_pessoas_anexos
     WHERE gestao_pessoa_id IN (${placeholders})
     ORDER BY criado_em`,
    registroIds
  );

  const map = new Map<number, AnexoRow[]>();
  for (const row of result.rows) {
    const r = row as AnexoRow;
    if (!map.has(r.gestao_pessoa_id)) map.set(r.gestao_pessoa_id, []);
    map.get(r.gestao_pessoa_id)!.push(r);
  }
  return map;
}

interface ReuniaoRow {
  id: number;
  gestao_pessoa_id: number;
  data: string;
  hora: string;
  status: string;
  observacoes: string | null;
}

interface ParticipanteRow {
  reuniao_id: number;
  colaborador_id: number;
  nome: string;
  cargo: string | null;
  departamento: string | null;
}

export interface ReuniaoFormatted {
  data: string | null;
  hora: string;
  participantes: { id: number; nome: string; cargo: string | null; departamento: string | null }[];
  status: string;
  observacoes: string | null;
}

export async function fetchReunioesComParticipantes(registroIds: number[]): Promise<Map<number, ReuniaoFormatted>> {
  if (registroIds.length === 0) return new Map();

  const placeholders = registroIds.map((_, i) => `$${i + 1}`).join(',');

  const reunioesResult = await query(
    `SELECT id, gestao_pessoa_id, data, hora, status, observacoes
     FROM bluepoint.bt_gestao_pessoas_reunioes
     WHERE gestao_pessoa_id IN (${placeholders})`,
    registroIds
  );

  const reunioes = reunioesResult.rows as ReuniaoRow[];
  if (reunioes.length === 0) return new Map();

  const reuniaoIds = reunioes.map(r => r.id);
  const pPlaceholders = reuniaoIds.map((_, i) => `$${i + 1}`).join(',');

  const partResult = await query(
    `SELECT p.reuniao_id, p.colaborador_id, c.nome, cg.nome AS cargo, d.nome AS departamento
     FROM bluepoint.bt_gestao_pessoas_participantes p
     JOIN bluepoint.bt_colaboradores c ON p.colaborador_id = c.id
     LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
     LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
     WHERE p.reuniao_id IN (${pPlaceholders})`,
    reuniaoIds
  );

  const partMap = new Map<number, ParticipanteRow[]>();
  for (const row of partResult.rows) {
    const p = row as ParticipanteRow;
    if (!partMap.has(p.reuniao_id)) partMap.set(p.reuniao_id, []);
    partMap.get(p.reuniao_id)!.push(p);
  }

  const map = new Map<number, ReuniaoFormatted>();
  for (const r of reunioes) {
    const participantes = (partMap.get(r.id) || []).map(p => ({
      id: p.colaborador_id,
      nome: p.nome,
      cargo: p.cargo,
      departamento: p.departamento,
    }));

    map.set(r.gestao_pessoa_id, {
      data: formatDateOnly(r.data),
      hora: r.hora,
      participantes,
      status: r.status,
      observacoes: r.observacoes,
    });
  }

  return map;
}

// =====================================================
// FORMATAÇÃO DO REGISTRO COMPLETO
// =====================================================

interface RegistroRow {
  id: number;
  colaborador_id: number;
  colaborador_nome: string;
  colaborador_cargo: string | null;
  colaborador_departamento: string | null;
  tipo: string;
  status: string;
  titulo: string;
  descricao: string;
  data_registro: string;
  data_conclusao: string | null;
  responsavel_nome: string;
}

export function formatRegistro(
  row: RegistroRow,
  anexos: AnexoRow[],
  reuniao: ReuniaoFormatted | null,
) {
  return {
    id: row.id,
    colaboradorId: row.colaborador_id,
    colaboradorNome: row.colaborador_nome,
    colaboradorCargo: row.colaborador_cargo,
    colaboradorDepartamento: row.colaborador_departamento,
    tipo: row.tipo,
    status: row.status,
    titulo: row.titulo,
    descricao: row.descricao,
    dataRegistro: formatDateOnly(row.data_registro),
    dataConclusao: formatDateOnly(row.data_conclusao),
    responsavel: row.responsavel_nome,
    anexos: anexos.map(formatAnexo),
    reuniao: reuniao || null,
  };
}
