import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import {
  errorResponse,
  serverErrorResponse,
  successResponse,
} from '@/lib/api-response';
import { gerarUrlPublica } from '@/lib/storage';

// =====================================================
// Rota pública /api/public/atualizacao-cadastral/[token]
//
// GET   → retorna lista de campos solicitados (keys do modal de
//         detalhes), tipos de documento solicitados (id+label),
//         e o snapshot dos dados ATUAIS do colaborador pra
//         pré-preencher o formulário.
// POST  → recebe respostas do colaborador (key → value) +
//         lista de docs anexados. Marca status='respondido'.
//
// Schema novo (sem form builder global): toda a info da
// solicitação carrega na própria row de
// people.solicitacoes_atualizacao_cadastral.
// =====================================================

interface Params {
  params: Promise<{ token: string }>;
}

// Mesmo conjunto de colunas que o modal de detalhes do front
// pode editar — com o TIPO de cada coluna pra coerce as respostas
// do colaborador antes do UPDATE. Front envia keys desse mapa; back
// devolve o valor atual e, no POST final, aplica direto na coluna.
type ColFieldType = 'text' | 'date' | 'numeric' | 'boolean';

const COLABORADOR_FIELDS: Record<string, ColFieldType> = {
  nome: 'text',
  email: 'text',
  cpf: 'text',
  rg: 'text',
  telefone: 'text',
  rg_orgao_emissor: 'text',
  rg_uf: 'text',
  estado_civil: 'text',
  formacao: 'text',
  cor_raca: 'text',
  uniforme_tamanho: 'text',
  contato_emergencia_nome: 'text',
  contato_emergencia_telefone: 'text',
  endereco_cep: 'text',
  endereco_logradouro: 'text',
  endereco_numero: 'text',
  endereco_complemento: 'text',
  endereco_bairro: 'text',
  endereco_cidade: 'text',
  endereco_estado: 'text',
  banco_nome: 'text',
  banco_tipo_conta: 'text',
  banco_agencia: 'text',
  banco_conta: 'text',
  pix_tipo: 'text',
  pix_chave: 'text',
  data_admissao: 'date',
  data_nascimento: 'date',
  altura_metros: 'numeric',
  peso_kg: 'numeric',
  auxilio_combustivel: 'boolean',
};

const COLABORADOR_COLUMNS = Object.keys(COLABORADOR_FIELDS);

const PG_CAST: Record<ColFieldType, string> = {
  text: 'text',
  date: 'date',
  numeric: 'numeric',
  boolean: 'boolean',
};

function coerceValor(raw: unknown, t: ColFieldType): unknown {
  if (raw === null || raw === undefined) return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof trimmed === 'string' && trimmed === '') return null;

  if (t === 'numeric') {
    const s = typeof trimmed === 'string' ? trimmed.replace(',', '.') : trimmed;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'boolean') {
    if (typeof trimmed === 'boolean') return trimmed;
    const str = String(trimmed).toLowerCase();
    if (['true', '1', 'sim', 's', 'yes', 'y'].includes(str)) return true;
    if (['false', '0', 'nao', 'não', 'n', 'no'].includes(str)) return false;
    return null;
  }
  if (t === 'date') {
    if (typeof trimmed !== 'string') return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(trimmed);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }
  return String(trimmed);
}

async function carregarTiposDocumento(ids: number[]) {
  if (!ids || ids.length === 0) return [];
  const r = await query<{ id: number; codigo: string; nome_exibicao: string }>(
    `SELECT id, codigo, nome_exibicao
       FROM people.tipos_documento_colaborador
      WHERE id = ANY($1::int[])
      ORDER BY nome_exibicao`,
    [ids],
  );
  return r.rows.map((t) => ({
    tipoDocumentoId: t.id,
    codigo: t.codigo,
    label: t.nome_exibicao,
  }));
}

async function carregarSnapshotColaborador(colabId: number, campos: string[]) {
  // Filtra só keys válidas pra evitar SQL inválido / colunas inexistentes.
  const safe = campos.filter((k) => COLABORADOR_COLUMNS.includes(k));
  if (safe.length === 0) return {};
  const sel = safe.map((c) => `"${c}"`).join(', ');
  const r = await query<Record<string, unknown>>(
    `SELECT ${sel}
       FROM people.colaboradores
      WHERE id = $1
      LIMIT 1`,
    [colabId],
  );
  return r.rows[0] ?? {};
}

interface SolicitacaoRow {
  id: string;
  colaborador_id: number;
  campos_solicitados: string[] | null;
  tipos_documento_ids: number[] | null;
  status: string;
  criado_em: string;
}

async function carregarSolicitacao(token: string): Promise<SolicitacaoRow | null> {
  const r = await query<SolicitacaoRow>(
    `SELECT id::text,
            colaborador_id,
            campos_solicitados,
            tipos_documento_ids,
            status,
            criado_em
       FROM people.solicitacoes_atualizacao_cadastral
      WHERE token = $1
      LIMIT 1`,
    [token],
  );
  return r.rows[0] ?? null;
}

// =====================================================
// GET
// =====================================================

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { token } = await params;
    const solicitacao = await carregarSolicitacao(token);
    if (!solicitacao) {
      return errorResponse('Token inválido ou solicitação não encontrada', 404);
    }
    if (solicitacao.status !== 'pendente' && solicitacao.status !== 'enviado') {
      return errorResponse('Esta solicitação já foi respondida ou expirou', 403);
    }

    const campos = Array.isArray(solicitacao.campos_solicitados)
      ? solicitacao.campos_solicitados.filter((c): c is string => typeof c === 'string')
      : [];
    const tiposDocIds = Array.isArray(solicitacao.tipos_documento_ids)
      ? solicitacao.tipos_documento_ids
      : [];

    const [tiposDocumento, snapshotColab, colabBasico] = await Promise.all([
      carregarTiposDocumento(tiposDocIds),
      carregarSnapshotColaborador(solicitacao.colaborador_id, campos),
      query<{ nome: string; cpf: string }>(
        `SELECT nome, cpf FROM people.colaboradores WHERE id = $1 LIMIT 1`,
        [solicitacao.colaborador_id],
      ),
    ]);

    if (colabBasico.rows.length === 0) {
      return errorResponse('Colaborador não encontrado', 404);
    }

    return successResponse({
      solicitacao: {
        id: solicitacao.id,
        status: solicitacao.status,
        criadoEm: solicitacao.criado_em,
      },
      colaborador: {
        nome: colabBasico.rows[0].nome,
        cpf: colabBasico.rows[0].cpf,
      },
      // Lista de campos pedidos pelo gestor + valor ATUAL pra pré-preencher.
      campos: campos.map((key) => ({
        key,
        valorAtual: snapshotColab[key] ?? null,
      })),
      tiposDocumento,
    });
  } catch (error) {
    console.error('[atualizacao-cadastral/public/GET] erro:', error);
    return serverErrorResponse('Erro ao obter solicitação de atualização');
  }
}

// =====================================================
// POST — colaborador envia respostas
// =====================================================

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { token } = await params;
    const solicitacao = await carregarSolicitacao(token);
    if (!solicitacao) {
      return errorResponse('Token inválido ou solicitação não encontrada', 404);
    }
    if (solicitacao.status !== 'pendente' && solicitacao.status !== 'enviado') {
      return errorResponse('Esta solicitação já foi respondida ou expirou', 403);
    }

    const body = await request.json().catch(() => ({}));
    const { dados, documentos } = body as {
      dados?: Record<string, unknown>;
      documentos?: unknown[];
    };

    if (!dados || typeof dados !== 'object') {
      return errorResponse('O campo "dados" é obrigatório e deve ser um objeto', 400);
    }

    // Documentos: aceita só metadata (uploads JÁ foram feitos via
    // POST /[token]/documento, que sobe pro MinIO e devolve storageKey).
    // Recusa qualquer payload com `contentBase64` pra impedir blobs
    // gigantes em JSONB.
    const docsBrutos = Array.isArray(documentos) ? documentos : [];
    const docs: Array<{
      tipoDocumentoId: number;
      storageKey: string;
      filename: string;
      contentType?: string;
    }> = [];
    for (const raw of docsBrutos) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.contentBase64 === 'string') {
        return errorResponse(
          'Upload via base64 não suportado — use POST /documento antes de finalizar',
          400,
        );
      }
      const tipoId = Number(r.tipoDocumentoId);
      const storageKey = typeof r.storageKey === 'string' ? r.storageKey : '';
      const filename = typeof r.filename === 'string' ? r.filename : '';
      if (!Number.isInteger(tipoId) || tipoId <= 0 || !storageKey) continue;
      docs.push({
        tipoDocumentoId: tipoId,
        storageKey,
        filename,
        contentType:
          typeof r.contentType === 'string' ? r.contentType : undefined,
      });
    }

    const respostas = { dados, documentos: docs };
    const camposPedidos = Array.isArray(solicitacao.campos_solicitados)
      ? solicitacao.campos_solicitados.filter(
          (c): c is string => typeof c === 'string',
        )
      : [];

    // Auto-aplica respostas direto no colaborador (sem revisão manual):
    //   1. UPDATE em people.colaboradores com colunas validadas (whitelist
    //      por tipo) — só atualiza campos que foram realmente pedidos
    //      pelo gestor (intersecção campos_solicitados ∩ keys recebidas).
    //   2. INSERT em people.documentos_colaborador pra cada doc enviado
    //      (storageKey já existe no MinIO via /[token]/documento).
    //   3. Marca solicitação como 'aplicado' (não mais 'respondido') —
    //      não precisa de tela de aprovação.
    // Tudo numa transação: se uma parte falhar, rollback global.
    const camposPedidosSet = new Set(camposPedidos);
    const colabId = solicitacao.colaborador_id;
    let camposAplicados = 0;
    let docsInseridos = 0;

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // 1. UPDATE colaborador.
      const sets: string[] = [];
      const valsUpd: unknown[] = [];
      let idx = 1;
      for (const [key, raw] of Object.entries(dados)) {
        const tipo = COLABORADOR_FIELDS[key];
        if (!tipo) continue;
        if (!camposPedidosSet.has(key)) continue;
        const v = coerceValor(raw, tipo);
        sets.push(`"${key}" = $${idx}::${PG_CAST[tipo]}`);
        valsUpd.push(v);
        idx++;
      }
      if (sets.length > 0) {
        valsUpd.push(colabId);
        await client.query(
          `UPDATE people.colaboradores
              SET ${sets.join(', ')}, atualizado_em = NOW()
            WHERE id = $${idx}`,
          valsUpd,
        );
        camposAplicados = sets.length;
      }

      // 2. INSERT docs — precisa do código de cada tipo (pra coluna `tipo`).
      if (docs.length > 0) {
        const ids = [...new Set(docs.map((d) => d.tipoDocumentoId))];
        const tiposR = await client.query<{ id: number; codigo: string }>(
          `SELECT id, codigo
             FROM people.tipos_documento_colaborador
            WHERE id = ANY($1::int[])`,
          [ids],
        );
        const codigoPorId = new Map(
          tiposR.rows.map((r) => [r.id, r.codigo]),
        );
        for (const d of docs) {
          const codigo = codigoPorId.get(d.tipoDocumentoId);
          if (!codigo) continue;
          const url = gerarUrlPublica(d.storageKey);
          await client.query(
            `INSERT INTO people.documentos_colaborador
               (colaborador_id, tipo, tipo_documento_id, nome, url, storage_key)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [colabId, codigo, d.tipoDocumentoId, d.filename, url, d.storageKey],
          );
          docsInseridos++;
        }
      }

      // 3. Solicitação finalizada.
      await client.query(
        `UPDATE people.solicitacoes_atualizacao_cadastral
            SET dados_respondidos = $2::jsonb,
                status            = 'aplicado',
                respondido_em     = NOW()
          WHERE id = $1::bigint`,
        [solicitacao.id, JSON.stringify(respostas)],
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    return successResponse({
      message: 'Atualização cadastral aplicada com sucesso',
      camposAplicados,
      docsInseridos,
    });
  } catch (error) {
    console.error('[atualizacao-cadastral/public/POST] erro:', error);
    return serverErrorResponse('Erro ao enviar resposta de atualização cadastral');
  }
}
