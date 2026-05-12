import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import { JWTPayload, isSuperAdmin } from '@/lib/auth';
import { obterEscopoGestor } from '@/lib/escopo-gestor';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { NIVEL_GESTOR, NIVEL_ADMIN } from '@/lib/niveis';

// GET /api/v1/search/global?q=joao&limit=5
//
// Busca GLOBAL no sistema. Pesquisa em paralelo em todas as entidades
// indexadas por nome/descrição e devolve resultados agrupados por
// categoria — pra topbar do site mostrar suggestion list separada por
// "Colaboradores", "Pré-admitidos", "Prestadores" etc.
//
// Escopo: respeita as regras de cada entidade (escopoGestor pra
// colaboradores/processos; públicas pra cargos/empresas/etc.). Super
// admin vê tudo. Gestor vê o que pode gerenciar. Colaborador comum
// só vê recursos públicos + ele mesmo.

interface SearchItem {
  id: string;
  title: string;
  subtitle?: string;
  route: string;
  // Hint visual pra UI — strings simples; o widget faz o mapeamento
  // pra Icon. Ex.: 'person', 'business', 'badge', 'work'.
  icon?: string;
}

interface SearchGroup {
  key: string;
  label: string;
  items: SearchItem[];
}

// Mínimo de caracteres pra disparar busca em entidades caras (evita
// scan completo). 2 caracteres já filtra bem com ILIKE.
const MIN_LENGTH = 2;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function ilikePattern(q: string): string {
  // Escapa wildcards do ILIKE pra evitar match acidental quando o
  // usuário digita '%' ou '_'.
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ===================== Helpers de cada entidade =====================
// Cada função roda 1 SELECT com LIMIT, devolve SearchItem[]. Falha
// best-effort: erro vira [] e a categoria some da resposta.

async function buscarColaboradores(
  q: string,
  limit: number,
  user: JWTPayload,
): Promise<SearchItem[]> {
  // Respeita escopoGestor: gestor só vê subordinados/empresa dele;
  // admin/super vê tudo.
  const userId = Number(user.userId);
  const isSuper = isSuperAdmin(user);
  const isAdmin = (user.nivelId ?? 0) >= NIVEL_ADMIN;
  const pattern = ilikePattern(q);

  let where = `(c.nome ILIKE $1 OR c.cpf ILIKE $1 OR c.email ILIKE $1)`;
  const params: unknown[] = [pattern];

  if (!isSuper && !isAdmin) {
    const escopo = await obterEscopoGestor(userId);
    // Colaborador comum (nível < gestor): só vê ele mesmo.
    if ((user.nivelId ?? 0) < NIVEL_GESTOR) {
      where += ` AND c.id = $${params.length + 1}`;
      params.push(userId);
    } else if (
      escopo.departamentoIds.length === 0 &&
      escopo.empresaIds.length === 0
    ) {
      // Gestor sem escopo cadastrado: ele mesmo + auto-escopo.
      where += ` AND c.id = $${params.length + 1}`;
      params.push(userId);
    } else {
      const conds: string[] = [];
      if (escopo.departamentoIds.length > 0) {
        conds.push(`c.departamento_id = ANY($${params.length + 1}::int[])`);
        params.push(escopo.departamentoIds);
      }
      if (escopo.empresaIds.length > 0) {
        conds.push(`c.empresa_id = ANY($${params.length + 1}::int[])`);
        params.push(escopo.empresaIds);
      }
      where += ` AND (${conds.join(' OR ')})`;
    }
  }

  params.push(limit);
  const result = await query<{
    id: number;
    nome: string;
    cargo_nome: string | null;
    departamento_nome: string | null;
    cpf: string | null;
  }>(
    `SELECT c.id, c.nome, c.cpf,
            cg.nome AS cargo_nome,
            d.nome  AS departamento_nome
       FROM people.colaboradores c
       LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
       LEFT JOIN people.departamentos d ON d.id = c.departamento_id
      WHERE ${where}
      ORDER BY c.nome
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle: [r.cargo_nome, r.departamento_nome].filter(Boolean).join(' • ') ||
      (r.cpf ?? undefined),
    route: `/colaboradores/${r.id}`,
    icon: 'person',
  }));
}

async function buscarPreAdmitidos(
  q: string,
  limit: number,
  user: JWTPayload,
): Promise<SearchItem[]> {
  // Provisórios + solicitações de admissão. Mostra quem está no pipeline.
  // Scope: admin/gestor da empresa veem todos.
  const isSuper = isSuperAdmin(user);
  const isAdmin = (user.nivelId ?? 0) >= NIVEL_ADMIN;
  const isGestor = (user.nivelId ?? 0) >= NIVEL_GESTOR;
  if (!isSuper && !isAdmin && !isGestor) return [];

  const pattern = ilikePattern(q);
  const params: unknown[] = [pattern];

  let scopeFilter = '';
  if (!isSuper && !isAdmin) {
    const escopo = await obterEscopoGestor(Number(user.userId));
    if (escopo.empresaIds.length === 0) return [];
    scopeFilter = ` AND up.empresa_id = ANY($${params.length + 1}::int[])`;
    params.push(escopo.empresaIds);
  }

  params.push(limit);
  const result = await query<{
    id: number;
    nome: string;
    cpf: string | null;
    cargo_nome: string | null;
    empresa_nome: string | null;
    solicitacao_id: string | null;
    status: string | null;
  }>(
    `SELECT up.id, up.nome, up.cpf,
            cg.nome AS cargo_nome,
            e.nome_fantasia AS empresa_nome,
            sa.id::text AS solicitacao_id,
            sa.status
       FROM people.usuarios_provisorios up
       LEFT JOIN people.cargos cg ON cg.id = up.cargo_id
       LEFT JOIN people.empresas e ON e.id = up.empresa_id
       LEFT JOIN LATERAL (
         SELECT id, status
           FROM people.solicitacoes_admissao
          WHERE usuario_provisorio_id = up.id
          ORDER BY criado_em DESC
          LIMIT 1
       ) sa ON true
      WHERE (up.nome ILIKE $1 OR up.cpf ILIKE $1)
        ${scopeFilter}
      ORDER BY up.criado_em DESC
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle:
      [r.cargo_nome, r.empresa_nome, r.status].filter(Boolean).join(' • ') ||
      (r.cpf ?? undefined),
    // Solicitação de admissão tem própria página; sem ela, vai direto
    // pra lista de pré-admitidos com filtro por id.
    route: r.solicitacao_id
      ? `/admissao/solicitacoes/${r.solicitacao_id}`
      : `/pre-admitidos?provisorioId=${r.id}`,
    icon: 'badge',
  }));
}

async function buscarPrestadores(
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    razao_social: string | null;
    nome_fantasia: string | null;
    cnpj_cpf: string | null;
    tipo: string | null;
    area_atuacao: string | null;
  }>(
    `SELECT id, razao_social, nome_fantasia, cnpj_cpf, tipo, area_atuacao
       FROM people.prestadores
      WHERE razao_social ILIKE $1
         OR nome_fantasia ILIKE $1
         OR cnpj_cpf ILIKE $1
      ORDER BY COALESCE(nome_fantasia, razao_social)
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome_fantasia || r.razao_social || `Prestador #${r.id}`,
    subtitle:
      [r.area_atuacao, r.cnpj_cpf, r.tipo].filter(Boolean).join(' • ') ||
      undefined,
    route: `/prestadores/${r.id}`,
    icon: 'engineering',
  }));
}

async function buscarEmpresas(q: string, limit: number): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome_fantasia: string | null;
    razao_social: string | null;
    cnpj: string | null;
  }>(
    `SELECT id, nome_fantasia, razao_social, cnpj
       FROM people.empresas
      WHERE nome_fantasia ILIKE $1
         OR razao_social ILIKE $1
         OR cnpj ILIKE $1
      ORDER BY COALESCE(nome_fantasia, razao_social)
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome_fantasia || r.razao_social || `Empresa #${r.id}`,
    subtitle: [r.razao_social, r.cnpj].filter(Boolean).join(' • ') || undefined,
    route: `/empresas/${r.id}`,
    icon: 'business',
  }));
}

async function buscarCargos(q: string, limit: number): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome: string;
    cbo: string | null;
    descricao: string | null;
  }>(
    `SELECT id, nome, cbo, descricao
       FROM people.cargos
      WHERE nome ILIKE $1
         OR cbo ILIKE $1
         OR descricao ILIKE $1
      ORDER BY nome
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle: r.cbo ? `CBO ${r.cbo}` : (r.descricao ?? undefined),
    route: `/cargos/${r.id}`,
    icon: 'work',
  }));
}

async function buscarDepartamentos(
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome: string;
    descricao: string | null;
  }>(
    `SELECT id, nome, descricao
       FROM people.departamentos
      WHERE nome ILIKE $1 OR descricao ILIKE $1
      ORDER BY nome
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle: r.descricao ?? undefined,
    route: `/departamentos/${r.id}`,
    icon: 'apartment',
  }));
}

async function buscarJornadas(q: string, limit: number): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome: string;
    descricao: string | null;
    carga_horaria_semanal: number | string | null;
  }>(
    `SELECT id, nome, descricao, carga_horaria_semanal
       FROM people.jornadas
      WHERE nome ILIKE $1 OR descricao ILIKE $1
      ORDER BY nome
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle: r.carga_horaria_semanal
      ? `${r.carga_horaria_semanal}h/semana`
      : (r.descricao ?? undefined),
    route: `/jornadas/${r.id}`,
    icon: 'schedule',
  }));
}

async function buscarLocalizacoes(
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome: string;
    tipo: string | null;
    cidade: string | null;
    estado: string | null;
  }>(
    `SELECT id, nome, tipo,
            (endereco->>'cidade') AS cidade,
            (endereco->>'estado') AS estado
       FROM people.localizacoes
      WHERE nome ILIKE $1
      ORDER BY nome
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle:
      [r.tipo, [r.cidade, r.estado].filter(Boolean).join('/')]
        .filter((s) => s && s.length > 0)
        .join(' • ') || undefined,
    route: `/localizacoes/${r.id}`,
    icon: 'place',
  }));
}

async function buscarClinicas(q: string, limit: number): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome: string;
    cidade: string | null;
    estado: string | null;
  }>(
    `SELECT id, nome,
            (endereco->>'cidade') AS cidade,
            (endereco->>'estado') AS estado
       FROM people.clinicas
      WHERE nome ILIKE $1
      ORDER BY nome
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle: [r.cidade, r.estado].filter(Boolean).join('/') || undefined,
    route: `/clinicas/${r.id}`,
    icon: 'local_hospital',
  }));
}

async function buscarExames(q: string, limit: number): Promise<SearchItem[]> {
  const pattern = ilikePattern(q);
  const result = await query<{
    id: number;
    nome: string;
    descricao: string | null;
  }>(
    `SELECT id, nome, descricao
       FROM people.exames
      WHERE nome ILIKE $1 OR descricao ILIKE $1
      ORDER BY nome
      LIMIT $2`,
    [pattern, limit],
  );

  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.nome,
    subtitle: r.descricao ?? undefined,
    route: `/exames/${r.id}`,
    icon: 'medical_services',
  }));
}

async function buscarCandidatos(
  q: string,
  limit: number,
  user: JWTPayload,
): Promise<SearchItem[]> {
  // Candidatos vivem em banco externo (Recrutamento). O processo seletivo
  // local guarda candidato_cpf_norm + candidato_recrutamento_id. Pra busca
  // por nome batemos no DB externo e depois fazemos JOIN local pra checar
  // escopo do gestor (empresa do processo).
  const isSuper = isSuperAdmin(user);
  const isAdmin = (user.nivelId ?? 0) >= NIVEL_ADMIN;
  const isGestor = (user.nivelId ?? 0) >= NIVEL_GESTOR;
  if (!isSuper && !isAdmin && !isGestor) return [];

  const pattern = ilikePattern(q);

  // Tenta busca por nome no DB externo. Se ele estiver fora do ar,
  // best-effort: devolve [] e a categoria some.
  let candidatosExt: Array<{ id: number; nome: string; cpf: string | null }>;
  try {
    const r = await queryRecrutamento<{
      id: number;
      nome: string;
      cpf: string | null;
    }>(
      `SELECT id, nome, cpf
         FROM public.candidatos
        WHERE nome ILIKE $1 OR cpf ILIKE $1
        ORDER BY nome
        LIMIT $2`,
      [pattern, limit * 3],
    );
    candidatosExt = r.rows;
  } catch (err) {
    console.warn('[search/global/candidatos] DB externo indisponível:', err);
    return [];
  }
  if (candidatosExt.length === 0) return [];

  // Filtra pelos que têm processo no escopo do gestor.
  const ids = candidatosExt.map((c) => c.id);
  const params: unknown[] = [ids];
  let scopeFilter = '';
  if (!isSuper && !isAdmin) {
    const escopo = await obterEscopoGestor(Number(user.userId));
    if (escopo.empresaIds.length === 0) return [];
    scopeFilter = ` AND ps.empresa_id = ANY($${params.length + 1}::int[])`;
    params.push(escopo.empresaIds);
  }
  params.push(limit);

  const local = await query<{
    processo_id: string;
    candidato_recrutamento_id: number;
    status: string | null;
    empresa_nome: string | null;
  }>(
    `SELECT DISTINCT ON (ps.candidato_recrutamento_id)
            ps.id::text AS processo_id,
            ps.candidato_recrutamento_id,
            ps.status,
            e.nome_fantasia AS empresa_nome
       FROM people.processo_seletivo ps
       LEFT JOIN people.empresas e ON e.id = ps.empresa_id
      WHERE ps.candidato_recrutamento_id = ANY($1::int[])
        ${scopeFilter}
      ORDER BY ps.candidato_recrutamento_id, ps.criado_em DESC
      LIMIT $${params.length}`,
    params,
  );

  const byId = new Map(candidatosExt.map((c) => [c.id, c]));
  return local.rows.map((r) => {
    const cand = byId.get(r.candidato_recrutamento_id);
    return {
      id: r.processo_id,
      title: cand?.nome ?? `Candidato #${r.candidato_recrutamento_id}`,
      subtitle:
        [r.empresa_nome, r.status, cand?.cpf].filter(Boolean).join(' • ') ||
        undefined,
      route: `/recrutamento/processos/${r.processo_id}`,
      icon: 'how_to_reg',
    };
  });
}

// ===================== Handler =====================

export async function GET(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const q = (searchParams.get('q') ?? '').trim();
      const limitRaw = Number(searchParams.get('limit') ?? DEFAULT_LIMIT);
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT),
      );

      if (q.length < MIN_LENGTH) {
        return errorResponse(
          `Termo de busca precisa ter pelo menos ${MIN_LENGTH} caracteres`,
          400,
        );
      }

      // Cada chamada é independente; falha individual não derruba o
      // endpoint. `allSettled` garante isso.
      const [
        colaboradores,
        preAdmitidos,
        prestadores,
        candidatos,
        empresas,
        cargos,
        departamentos,
        jornadas,
        localizacoes,
        clinicas,
        exames,
      ] = await Promise.allSettled([
        buscarColaboradores(q, limit, user),
        buscarPreAdmitidos(q, limit, user),
        buscarPrestadores(q, limit),
        buscarCandidatos(q, limit, user),
        buscarEmpresas(q, limit),
        buscarCargos(q, limit),
        buscarDepartamentos(q, limit),
        buscarJornadas(q, limit),
        buscarLocalizacoes(q, limit),
        buscarClinicas(q, limit),
        buscarExames(q, limit),
      ]);

      const settled = (
        r: PromiseSettledResult<SearchItem[]>,
      ): SearchItem[] => (r.status === 'fulfilled' ? r.value : []);

      // Ordem importa: a UI mostra as categorias nessa sequência. Pessoas
      // primeiro (mais procurado), depois recursos.
      const groupsRaw: SearchGroup[] = [
        { key: 'colaboradores', label: 'Colaboradores', items: settled(colaboradores) },
        { key: 'preAdmitidos', label: 'Pré-admitidos', items: settled(preAdmitidos) },
        { key: 'candidatos', label: 'Candidatos', items: settled(candidatos) },
        { key: 'prestadores', label: 'Prestadores', items: settled(prestadores) },
        { key: 'empresas', label: 'Empresas', items: settled(empresas) },
        { key: 'cargos', label: 'Cargos', items: settled(cargos) },
        { key: 'departamentos', label: 'Departamentos', items: settled(departamentos) },
        { key: 'jornadas', label: 'Jornadas', items: settled(jornadas) },
        { key: 'localizacoes', label: 'Localizações', items: settled(localizacoes) },
        { key: 'clinicas', label: 'Clínicas', items: settled(clinicas) },
        { key: 'exames', label: 'Exames', items: settled(exames) },
      ];

      // Filtra grupos vazios — a UI só lista o que tem hit.
      const groups = groupsRaw.filter((g) => g.items.length > 0);
      const total = groups.reduce((acc, g) => acc + g.items.length, 0);

      return successResponse({ q, total, groups });
    } catch (error) {
      console.error('[search/global] erro:', error);
      return serverErrorResponse('Erro na busca global');
    }
  });
}
