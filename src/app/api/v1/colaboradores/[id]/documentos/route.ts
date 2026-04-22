import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  createdResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { uploadDocumentoColaborador } from '@/lib/storage';
import { invalidateDocumentosColaboradorCache } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { criarNotificacaoComPush } from '@/lib/notificacoes';

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const EXTENSOES_PERMITIDAS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx']);

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/colaboradores/:id/documentos
 * FormData: tipoDocumentoId (number), arquivo (File), dataValidade (optional, YYYY-MM-DD)
 * Faz upload do arquivo para o MinIO e grava registro em documentos_colaborador.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colabResult = await query(
        `SELECT id, nome FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colabResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const formData = await req.formData();
      const tipoDocumentoIdRaw = formData.get('tipoDocumentoId');
      const arquivo = formData.get('arquivo') as File | null;
      const dataValidadeStr = formData.get('dataValidade') as string | null;

      if (!tipoDocumentoIdRaw || !arquivo) {
        return errorResponse('Campos tipoDocumentoId e arquivo são obrigatórios', 400);
      }

      const tipoDocumentoId = parseInt(String(tipoDocumentoIdRaw));
      if (isNaN(tipoDocumentoId)) {
        return errorResponse('tipoDocumentoId inválido', 400);
      }

      const tipoResult = await query(
        `SELECT id, codigo, nome_exibicao, validade_meses
         FROM people.tipos_documento_colaborador
         WHERE id = $1`,
        [tipoDocumentoId]
      );

      if (tipoResult.rows.length === 0) {
        return errorResponse('Tipo de documento não encontrado', 400);
      }

      const codigoTipo = tipoResult.rows[0].codigo as string;
      const validadeMeses = tipoResult.rows[0].validade_meses as number | null;

      if (arquivo.size > MAX_FILE_SIZE) {
        return errorResponse('Arquivo muito grande. Máximo 15 MB.', 400);
      }

      const ext = (arquivo.name.split('.').pop() || '').toLowerCase();
      if (!EXTENSOES_PERMITIDAS.has(ext)) {
        return errorResponse(
          'Tipo de arquivo não permitido. Use: PDF, JPG, PNG, DOC ou DOCX.',
          400
        );
      }

      let dataValidade: string | null = null;
      if (dataValidadeStr && dataValidadeStr.trim()) {
        const d = new Date(dataValidadeStr);
        if (Number.isNaN(d.getTime())) {
          return errorResponse('dataValidade inválida. Use YYYY-MM-DD.', 400);
        }
        dataValidade = dataValidadeStr.trim().substring(0, 10);
      } else if (validadeMeses) {
        const d = new Date();
        d.setMonth(d.getMonth() + validadeMeses);
        dataValidade = d.toISOString().substring(0, 10);
      }

      const buffer = Buffer.from(await arquivo.arrayBuffer());
      const contentType = arquivo.type || 'application/octet-stream';

      const { url, storageKey } = await uploadDocumentoColaborador(
        colaboradorId,
        codigoTipo,
        buffer,
        contentType,
        arquivo.name
      );

      const insertResult = await query(
        `INSERT INTO people.documentos_colaborador
         (colaborador_id, tipo, tipo_documento_id, nome, url, storage_key, tamanho, data_validade)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, colaborador_id, tipo, tipo_documento_id, nome, url, storage_key, tamanho, data_upload, data_validade`,
        [
          colaboradorId,
          codigoTipo,
          tipoDocumentoId,
          arquivo.name,
          url,
          storageKey,
          arquivo.size,
          dataValidade,
        ]
      );

      const row = insertResult.rows[0];

      await invalidateDocumentosColaboradorCache(colaboradorId);

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'criar',
          modulo: 'colaboradores',
          descricao: `Documento ${codigoTipo} anexado ao colaborador ${colabResult.rows[0].nome}`,
          entidadeId: colaboradorId,
          entidadeTipo: 'colaborador',
          dadosNovos: { documentoId: row.id, tipo: codigoTipo, nome: arquivo.name },
        })
      );

      const hoje = new Date().toISOString().substring(0, 10);
      const diasParaVencer =
        row.data_validade == null
          ? null
          : Math.floor(
              (new Date(row.data_validade).getTime() - new Date(hoje).getTime()) /
                (24 * 60 * 60 * 1000)
            );

      const nomeExibicao = tipoResult.rows[0].nome_exibicao as string;
      const validadeMsg = row.data_validade
        ? ` Válido até ${new Date(row.data_validade).toLocaleDateString('pt-BR')}.`
        : '';
      criarNotificacaoComPush({
        usuarioId: colaboradorId,
        tipo: 'sistema',
        titulo: 'Novo documento adicionado',
        mensagem: `O documento "${nomeExibicao}" foi adicionado à sua pasta.${validadeMsg}`,
        link: '/documentos',
        metadados: { acao: 'documento_adicionado', documentoId: row.id, tipo: codigoTipo },
        pushSeveridade: 'info',
      }).catch((err) => console.error('[Notificação] Erro ao notificar documento:', err));

      return createdResponse({
        id: row.id,
        colaboradorId: row.colaborador_id,
        tipo: row.tipo,
        tipoDocumentoId: row.tipo_documento_id,
        nome: row.nome,
        url: row.url,
        tamanho: row.tamanho,
        dataUpload: row.data_upload,
        dataValidade: row.data_validade,
        diasParaVencer,
      });
    } catch (error) {
      console.error('Erro ao enviar documento do colaborador:', error);
      return serverErrorResponse('Erro ao enviar documento');
    }
  });
}
