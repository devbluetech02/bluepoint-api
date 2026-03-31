import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarContratoPrestadorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateContratoPrestadorCache } from '@/lib/cache';
import { uploadContratoPrestador } from '@/lib/storage';

function parseBodyFromFormData(formData: FormData): Record<string, unknown> {
  const get = (k: string) => formData.get(k) as string | null;
  const prestadorId = get('prestadorId');
  const valor = get('valor');
  const alertaRenovacaoDias = get('alertaRenovacaoDias');
  return {
    prestadorId: prestadorId != null ? Number(prestadorId) : undefined,
    numero: get('numero') ?? undefined,
    descricao: get('descricao') || undefined,
    dataInicio: get('dataInicio') ?? undefined,
    dataFim: get('dataFim') || undefined,
    valor: valor != null ? Number(valor) : undefined,
    formaPagamento: get('formaPagamento') ?? undefined,
    status: get('status') ?? undefined,
    alertaRenovacaoDias: alertaRenovacaoDias != null ? Number(alertaRenovacaoDias) : undefined,
    observacoes: get('observacoes') || undefined,
  };
}

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
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

      const validation = validateBody(criarContratoPrestadorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const prestadorResult = await query(
        `SELECT id, nome_fantasia FROM people.prestadores WHERE id = $1`,
        [data.prestadorId]
      );

      if (prestadorResult.rows.length === 0) {
        return errorResponse('Prestador não encontrado', 404);
      }

      const prestadorId = data.prestadorId;
      const prestadorNome = prestadorResult.rows[0].nome_fantasia as string;

      let arquivoUrl: string | null = data.arquivoUrl ?? null;
      if (arquivo && arquivo.size > 0) {
        const buffer = Buffer.from(await arquivo.arrayBuffer());
        const nomeArquivo = arquivo.name || `contrato-${data.numero}.pdf`;
        arquivoUrl = await uploadContratoPrestador(
          prestadorId,
          prestadorNome,
          buffer,
          arquivo.type || 'application/pdf',
          nomeArquivo
        );
      }

      const result = await query(
        `INSERT INTO people.contratos_prestador (
          prestador_id, numero, descricao, data_inicio, data_fim,
          valor, forma_pagamento, status, alerta_renovacao_dias, observacoes, arquivo_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          data.prestadorId,
          data.numero,
          data.descricao || null,
          data.dataInicio,
          data.dataFim || null,
          data.valor,
          data.formaPagamento,
          data.status ?? 'vigente',
          data.alertaRenovacaoDias ?? 30,
          data.observacoes || null,
          arquivoUrl,
        ]
      );

      const row = result.rows[0];
      const novo = {
        id: row.id,
        prestadorId: row.prestador_id,
        prestadorNome,
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

      await invalidateContratoPrestadorCache();

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'contratos_prestador',
        descricao: `Contrato criado: ${novo.numero} para ${prestadorNome}`,
        entidadeId: novo.id,
        entidadeTipo: 'contrato_prestador',
        dadosNovos: { id: novo.id, numero: novo.numero, prestadorId: novo.prestadorId },
      }));

      return createdResponse(novo);
    } catch (error) {
      console.error('Erro ao criar contrato de prestador:', error);
      return serverErrorResponse('Erro ao criar contrato de prestador');
    }
  });
}
