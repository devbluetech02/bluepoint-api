import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarNfePrestadorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateNfePrestadorCache } from '@/lib/cache';
import { uploadNfePrestador } from '@/lib/storage';

interface Params {
  params: Promise<{ id: string }>;
}

function parseBodyFromFormData(formData: FormData): Record<string, unknown> {
  const get = (k: string) => formData.get(k) as string | null;
  const prestadorId = get('prestadorId');
  const contratoId = get('contratoId');
  const valor = get('valor');
  return {
    prestadorId: prestadorId != null ? Number(prestadorId) : undefined,
    contratoId: contratoId != null && contratoId !== '' ? Number(contratoId) : undefined,
    numero: get('numero') ?? undefined,
    serie: get('serie') ?? undefined,
    chaveAcesso: get('chaveAcesso') ?? undefined,
    dataEmissao: get('dataEmissao') ?? undefined,
    valor: valor != null ? Number(valor) : undefined,
    status: get('status') ?? undefined,
    observacoes: get('observacoes') ?? undefined,
  };
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const nfeId = parseInt(id);

      if (isNaN(nfeId)) {
        return notFoundResponse('NFe não encontrada');
      }

      const contentType = req.headers.get('content-type') ?? '';
      let body: Record<string, unknown>;
      let arquivo: File | null = null;

      if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData();
        body = parseBodyFromFormData(formData);
        arquivo = formData.get('arquivo') as File | null;
      } else {
        body = await req.json();
      }

      const validation = validateBody(atualizarNfePrestadorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const atualResult = await query(
        `SELECT n.*, p.nome_fantasia as prestador_nome, c.numero as contrato_numero
         FROM bluepoint.bt_nfes_prestador n
         JOIN bluepoint.bt_prestadores p ON n.prestador_id = p.id
         LEFT JOIN bluepoint.bt_contratos_prestador c ON n.contrato_id = c.id
         WHERE n.id = $1`,
        [nfeId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('NFe não encontrada');
      }

      const dadosAnteriores = atualResult.rows[0];
      let prestadorId = data.prestadorId ?? dadosAnteriores.prestador_id;
      let prestadorNome = dadosAnteriores.prestador_nome as string;

      if (data.prestadorId) {
        const prestadorExiste = await query(
          `SELECT id, nome_fantasia FROM bluepoint.bt_prestadores WHERE id = $1`,
          [data.prestadorId]
        );
        if (prestadorExiste.rows.length === 0) {
          return errorResponse('Prestador não encontrado', 404);
        }
        prestadorId = data.prestadorId;
        prestadorNome = prestadorExiste.rows[0].nome_fantasia as string;
      }

      if (data.contratoId) {
        const prestId = data.prestadorId || dadosAnteriores.prestador_id;
        const contratoExiste = await query(
          `SELECT id FROM bluepoint.bt_contratos_prestador WHERE id = $1 AND prestador_id = $2`,
          [data.contratoId, prestId]
        );
        if (contratoExiste.rows.length === 0) {
          return errorResponse('Contrato não encontrado ou não pertence ao prestador', 404);
        }
      }

      let arquivoUrl: string | null | undefined = data.arquivoUrl;
      if (arquivo && arquivo.size > 0) {
        const buffer = Buffer.from(await arquivo.arrayBuffer());
        const nomeArquivo = arquivo.name || `nfe-${dadosAnteriores.numero}.pdf`;
        arquivoUrl = await uploadNfePrestador(
          prestadorId,
          prestadorNome,
          buffer,
          arquivo.type || 'application/pdf',
          nomeArquivo
        );
      }

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      const fieldsMap: Record<string, string> = {
        prestadorId: 'prestador_id',
        contratoId: 'contrato_id',
        numero: 'numero',
        serie: 'serie',
        chaveAcesso: 'chave_acesso',
        dataEmissao: 'data_emissao',
        valor: 'valor',
        status: 'status',
        arquivoUrl: 'arquivo_url',
        observacoes: 'observacoes',
      };

      const dataComArquivo = { ...data };
      if (arquivoUrl !== undefined) {
        dataComArquivo.arquivoUrl = arquivoUrl;
      }

      for (const [jsField, dbField] of Object.entries(fieldsMap)) {
        if (dataComArquivo[jsField as keyof typeof dataComArquivo] !== undefined) {
          setClauses.push(`${dbField} = $${paramIndex}`);
          values.push(dataComArquivo[jsField as keyof typeof dataComArquivo]);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) {
        return errorResponse('Nenhum campo para atualizar', 400);
      }

      setClauses.push('atualizado_em = NOW()');
      values.push(nfeId);

      await query(
        `UPDATE bluepoint.bt_nfes_prestador SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      const updatedResult = await query(
        `SELECT n.*, p.nome_fantasia as prestador_nome, c.numero as contrato_numero
         FROM bluepoint.bt_nfes_prestador n
         JOIN bluepoint.bt_prestadores p ON n.prestador_id = p.id
         LEFT JOIN bluepoint.bt_contratos_prestador c ON n.contrato_id = c.id
         WHERE n.id = $1`,
        [nfeId]
      );
      const row = updatedResult.rows[0];
      const atualizado = {
        id: row.id,
        prestadorId: row.prestador_id,
        prestadorNome: row.prestador_nome,
        contratoId: row.contrato_id,
        contratoNumero: row.contrato_numero,
        numero: row.numero,
        serie: row.serie,
        chaveAcesso: row.chave_acesso,
        dataEmissao: row.data_emissao,
        valor: parseFloat(row.valor),
        status: row.status,
        arquivoUrl: row.arquivo_url,
        observacoes: row.observacoes,
        createdAt: row.criado_em,
        updatedAt: row.atualizado_em,
      };

      await invalidateNfePrestadorCache(nfeId);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'editar',
        modulo: 'nfes_prestador',
        descricao: `NFe atualizada: ${atualizado.numero}`,
        entidadeId: nfeId,
        entidadeTipo: 'nfe_prestador',
        dadosAnteriores: { id: nfeId, ...dadosAnteriores },
        dadosNovos: { id: nfeId, ...data },
      }));

      return successResponse(atualizado);
    } catch (error) {
      console.error('Erro ao atualizar NFe de prestador:', error);
      return serverErrorResponse('Erro ao atualizar NFe de prestador');
    }
  });
}
