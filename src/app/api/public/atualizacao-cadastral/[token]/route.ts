import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  errorResponse,
  serverErrorResponse,
  successResponse,
} from '@/lib/api-response';

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
// pode editar. Front envia uma chave dessa lista; back devolve
// o valor atual nesse mesmo nome pra pré-preencher.
const COLABORADOR_COLUMNS = [
  'nome', 'email', 'cpf', 'rg', 'telefone',
  'data_admissao', 'data_nascimento',
  'rg_orgao_emissor', 'rg_uf',
  'estado_civil', 'formacao', 'cor_raca',
  'uniforme_tamanho', 'altura_metros', 'peso_kg',
  'contato_emergencia_nome', 'contato_emergencia_telefone',
  'endereco_cep', 'endereco_logradouro', 'endereco_numero',
  'endereco_complemento', 'endereco_bairro', 'endereco_cidade',
  'endereco_estado',
  'banco_nome', 'banco_tipo_conta', 'banco_agencia', 'banco_conta',
  'pix_tipo', 'pix_chave',
  'auxilio_combustivel',
];

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

    // Mescla dados + docs num único JSON pro snapshot da resposta.
    const respostas = {
      dados,
      documentos: Array.isArray(documentos) ? documentos : [],
    };

    await query(
      `UPDATE people.solicitacoes_atualizacao_cadastral
          SET dados_respondidos = $2::jsonb,
              status            = 'respondido',
              respondido_em     = NOW()
        WHERE id = $1::bigint`,
      [solicitacao.id, JSON.stringify(respostas)],
    );

    return successResponse({ message: 'Atualização cadastral enviada com sucesso' });
  } catch (error) {
    console.error('[atualizacao-cadastral/public/POST] erro:', error);
    return serverErrorResponse('Erro ao enviar resposta de atualização cadastral');
  }
}
