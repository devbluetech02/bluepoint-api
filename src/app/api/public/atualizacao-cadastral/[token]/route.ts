import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/api-response';

interface Params {
  params: Promise<{ token: string }>;
}

// =====================================================
// Helpers
// =====================================================

function mapCamposParaApi(campos: unknown, apenasAtivos = false) {
  if (!Array.isArray(campos)) return [];
  const mapped = campos.map((campo) => {
    const item = (campo ?? {}) as Record<string, unknown>;
    return {
      id: typeof item.id === 'string' ? item.id : null,
      label: typeof item.label === 'string' ? item.label : '',
      tipo: typeof item.tipo === 'string' ? item.tipo : '',
      obrigatorio: Boolean(item.obrigatorio),
      ativo: item.ativo === undefined ? true : Boolean(item.ativo),
      ordem: typeof item.ordem === 'number' ? item.ordem : 0,
      opcoes: Array.isArray(item.opcoes) ? item.opcoes.filter((v): v is string => typeof v === 'string') : [],
      secaoNome:
        typeof item.secao_nome === 'string'
          ? item.secao_nome
          : typeof item.secaoNome === 'string'
            ? item.secaoNome
            : null,
    };
  });
  return apenasAtivos ? mapped.filter((c) => c.ativo) : mapped;
}

async function fetchDocumentosRequeridos(raw: unknown, documentosSelecionados: number[]) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const items = raw
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const id =
        typeof item.tipoDocumentoId === 'number'
          ? item.tipoDocumentoId
          : typeof item.tipo_documento_id === 'number'
            ? item.tipo_documento_id
            : null;
      if (!id || !Number.isInteger(id) || id < 1) return null;
      return {
        tipoDocumentoId: id,
        obrigatorio: Boolean(item.obrigatorio),
      };
    })
    .filter((x): x is { tipoDocumentoId: number; obrigatorio: boolean } => x !== null);

  // Filtrar apenas os documentos selecionados na solicitação
  const filtered = documentosSelecionados.length > 0
    ? items.filter((item) => documentosSelecionados.includes(item.tipoDocumentoId))
    : items;

  if (filtered.length === 0) return [];

  const ids = [...new Set(filtered.map((i) => i.tipoDocumentoId))];
  const tiposResult = await query(
    `SELECT id, codigo, nome_exibicao
     FROM people.tipos_documento_colaborador
     WHERE id = ANY($1::int[])`,
    [ids]
  );
  const byId = new Map(
    (tiposResult.rows as { id: number; codigo: string; nome_exibicao: string }[]).map((r) => [r.id, r])
  );

  return filtered.map((item) => {
    const tipo = byId.get(item.tipoDocumentoId);
    return {
      tipoDocumentoId: item.tipoDocumentoId,
      codigo: tipo?.codigo ?? '',
      label: tipo?.nome_exibicao ?? '',
      obrigatorio: item.obrigatorio,
    };
  });
}

// =====================================================
// GET — Busca o formulário + dados atuais do colaborador
// =====================================================

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { token } = await params;

    // Buscar solicitação pelo token
    const solResult = await query(
      `SELECT id, colaborador_id, campos_selecionados, documentos_selecionados, status, expira_em
       FROM people.solicitacoes_atualizacao_cadastral
       WHERE token_publico = $1
       LIMIT 1`,
      [token]
    );

    if (solResult.rows.length === 0) {
      return errorResponse('Token inválido ou solicitação não encontrada', 404);
    }

    const solicitacao = solResult.rows[0] as {
      id: number;
      colaborador_id: number;
      campos_selecionados: string[];
      documentos_selecionados: number[];
      status: string;
      expira_em: string;
    };

    // Verificar status válido
    if (solicitacao.status !== 'pendente' && solicitacao.status !== 'enviado') {
      return errorResponse('Esta solicitação já foi respondida ou expirou', 403);
    }

    // Verificar expiração
    if (new Date(solicitacao.expira_em) < new Date()) {
      return errorResponse('Esta solicitação expirou', 403);
    }

    // Buscar o template do formulário
    const formResult = await query(
      `SELECT id, titulo, campos, documentos_requeridos
       FROM people.formularios_atualizacao_cadastral
       WHERE ativo = true
       ORDER BY atualizado_em DESC
       LIMIT 1`
    );

    if (formResult.rows.length === 0) {
      return errorResponse('Formulário de atualização cadastral não encontrado', 404);
    }

    const formulario = formResult.rows[0];

    // Filtrar campos para incluir apenas os selecionados na solicitação
    const todosCampos = mapCamposParaApi(formulario.campos, true);
    const camposFiltrados = solicitacao.campos_selecionados.length > 0
      ? todosCampos.filter((campo) =>
          solicitacao.campos_selecionados.includes(campo.id ?? '') ||
          solicitacao.campos_selecionados.includes(campo.label)
        )
      : todosCampos;

    // Buscar documentos requeridos filtrados
    const documentosSelecionados = Array.isArray(solicitacao.documentos_selecionados)
      ? solicitacao.documentos_selecionados
      : [];
    const documentos = await fetchDocumentosRequeridos(formulario.documentos_requeridos, documentosSelecionados);

    // Buscar dados atuais do colaborador
    const colabResult = await query(
      `SELECT nome, cpf, email, telefone, rg,
              endereco_cep, endereco_logradouro, endereco_numero,
              endereco_complemento, endereco_bairro, endereco_cidade, endereco_estado
       FROM people.colaboradores
       WHERE id = $1`,
      [solicitacao.colaborador_id]
    );

    if (colabResult.rows.length === 0) {
      return errorResponse('Colaborador não encontrado', 404);
    }

    const colab = colabResult.rows[0] as Record<string, unknown>;

    return successResponse({
      formulario: {
        titulo: formulario.titulo,
        campos: camposFiltrados,
        documentos,
      },
      colaborador: {
        nome: colab.nome,
        cpf: colab.cpf,
        email: colab.email,
        telefone: colab.telefone,
        rg: colab.rg,
        endereco: {
          cep: colab.endereco_cep,
          logradouro: colab.endereco_logradouro,
          numero: colab.endereco_numero,
          complemento: colab.endereco_complemento,
          bairro: colab.endereco_bairro,
          cidade: colab.endereco_cidade,
          estado: colab.endereco_estado,
        },
      },
      solicitacao: {
        id: solicitacao.id,
        status: solicitacao.status,
        expiraEm: solicitacao.expira_em,
      },
    });
  } catch (error) {
    console.error('Erro ao obter formulário de atualização cadastral público:', error);
    return serverErrorResponse('Erro ao obter formulário de atualização cadastral');
  }
}

// =====================================================
// POST — Envia a resposta do colaborador
// =====================================================

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { token } = await params;

    // Buscar solicitação pelo token
    const solResult = await query(
      `SELECT id, status, expira_em
       FROM people.solicitacoes_atualizacao_cadastral
       WHERE token_publico = $1
       LIMIT 1`,
      [token]
    );

    if (solResult.rows.length === 0) {
      return errorResponse('Token inválido ou solicitação não encontrada', 404);
    }

    const solicitacao = solResult.rows[0] as {
      id: number;
      status: string;
      expira_em: string;
    };

    // Verificar status válido
    if (solicitacao.status !== 'pendente' && solicitacao.status !== 'enviado') {
      return errorResponse('Esta solicitação já foi respondida ou expirou', 403);
    }

    // Verificar expiração
    if (new Date(solicitacao.expira_em) < new Date()) {
      return errorResponse('Esta solicitação expirou', 403);
    }

    // Parsear body
    const body = await request.json();
    const { dados, documentos } = body as { dados?: Record<string, unknown>; documentos?: unknown[] };

    if (!dados || typeof dados !== 'object') {
      return errorResponse('O campo "dados" é obrigatório e deve ser um objeto');
    }

    // Atualizar a solicitação com a resposta
    await query(
      `UPDATE people.solicitacoes_atualizacao_cadastral
       SET dados_resposta = $2::jsonb,
           documentos_resposta = $3::jsonb,
           status = 'respondido',
           respondido_em = NOW()
       WHERE id = $1`,
      [
        solicitacao.id,
        JSON.stringify(dados),
        JSON.stringify(documentos ?? []),
      ]
    );

    return successResponse({ message: 'Atualização cadastral enviada com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar resposta de atualização cadastral:', error);
    return serverErrorResponse('Erro ao enviar resposta de atualização cadastral');
  }
}
