import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarContratoPrestadorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateContratoPrestadorCache } from '@/lib/cache';
import { uploadContratoPrestador } from '@/lib/storage';

interface Params {
  params: Promise<{ id: string }>;
}

function parseBodyFromFormData(formData: FormData): Record<string, unknown> {
  const get = (k: string) => formData.get(k) as string | null;
  const prestadorId = get('prestadorId');
  const valor = get('valor');
  const alertaRenovacaoDias = get('alertaRenovacaoDias');
  return {
    prestadorId: prestadorId != null ? Number(prestadorId) : undefined,
    numero: get('numero') ?? undefined,
    descricao: get('descricao') ?? undefined,
    dataInicio: get('dataInicio') ?? undefined,
    dataFim: get('dataFim') ?? undefined,
    valor: valor != null ? Number(valor) : undefined,
    formaPagamento: get('formaPagamento') ?? undefined,
    status: get('status') ?? undefined,
    alertaRenovacaoDias: alertaRenovacaoDias != null ? Number(alertaRenovacaoDias) : undefined,
    observacoes: get('observacoes') ?? undefined,
  };
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const contratoId = parseInt(id);

      if (isNaN(contratoId)) {
        return notFoundResponse('Contrato não encontrado');
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

      const validation = validateBody(atualizarContratoPrestadorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const atualResult = await query(
        `SELECT c.*, p.nome_fantasia as prestador_nome
         FROM people.contratos_prestador c
         JOIN people.prestadores p ON c.prestador_id = p.id
         WHERE c.id = $1`,
        [contratoId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Contrato não encontrado');
      }

      const dadosAnteriores = atualResult.rows[0];
      let prestadorId = data.prestadorId ?? dadosAnteriores.prestador_id;
      let prestadorNome = dadosAnteriores.prestador_nome as string;

      if (data.prestadorId) {
        const prestadorExiste = await query(
          `SELECT id, nome_fantasia FROM people.prestadores WHERE id = $1`,
          [data.prestadorId]
        );
        if (prestadorExiste.rows.length === 0) {
          return errorResponse('Prestador não encontrado', 404);
        }
        prestadorId = data.prestadorId;
        prestadorNome = prestadorExiste.rows[0].nome_fantasia as string;
      }

      let arquivoUrl: string | null | undefined = data.arquivoUrl;
      if (arquivo && arquivo.size > 0) {
        const buffer = Buffer.from(await arquivo.arrayBuffer());
        const nomeArquivo = arquivo.name || `contrato-${dadosAnteriores.numero}.pdf`;
        arquivoUrl = await uploadContratoPrestador(
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
        numero: 'numero',
        descricao: 'descricao',
        dataInicio: 'data_inicio',
        dataFim: 'data_fim',
        valor: 'valor',
        formaPagamento: 'forma_pagamento',
        status: 'status',
        alertaRenovacaoDias: 'alerta_renovacao_dias',
        observacoes: 'observacoes',
        arquivoUrl: 'arquivo_url',
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
      values.push(contratoId);

      await query(
        `UPDATE people.contratos_prestador SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      const updatedResult = await query(
        `SELECT c.*, p.nome_fantasia as prestador_nome
         FROM people.contratos_prestador c
         JOIN people.prestadores p ON c.prestador_id = p.id
         WHERE c.id = $1`,
        [contratoId]
      );
      const row = updatedResult.rows[0];
      const atualizado = {
        id: row.id,
        prestadorId: row.prestador_id,
        prestadorNome: row.prestador_nome,
        numero: row.numero,
        descricao: row.descricao,
        dataInicio: row.data_inicio,
        dataFim: row.data_fim,
        valor: parseFloat(row.valor),
        formaPagamento: row.forma_pagamento,
        status: row.status,
        alertaRenovacaoDias: row.alerta_renovacao_dias,
        observacoes: row.observacoes,
        arquivoUrl: row.arquivo_url,
        createdAt: row.criado_em,
        updatedAt: row.atualizado_em,
      };

      await invalidateContratoPrestadorCache(contratoId);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'editar',
        modulo: 'contratos_prestador',
        descricao: `Contrato atualizado: ${atualizado.numero}`,
        entidadeId: contratoId,
        entidadeTipo: 'contrato_prestador',
        dadosAnteriores: { id: contratoId, ...dadosAnteriores },
        dadosNovos: { id: contratoId, ...data },
      }));

      return successResponse(atualizado);
    } catch (error) {
      console.error('Erro ao atualizar contrato de prestador:', error);
      return serverErrorResponse('Erro ao atualizar contrato de prestador');
    }
  });
}
