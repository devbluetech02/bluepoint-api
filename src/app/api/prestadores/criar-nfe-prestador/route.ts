import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarNfePrestadorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateNfePrestadorCache } from '@/lib/cache';
import { uploadNfePrestador } from '@/lib/storage';

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

/**
 * POST /api/prestadores/criar-nfe-prestador
 * Cadastra NFe vinculada a prestador (e opcionalmente a um contrato).
 * Mesma lógica de /api/v1/criar-nfe-prestador para compatibilidade com clientes que usam o path /api/prestadores/*.
 */
export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const contentType = req.headers.get('content-type') ?? '';
      let body: Record<string, unknown>;
      let arquivo: File | null = null;

      if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData();
        body = parseBodyFromFormData(formData);
        arquivo = (formData.get('arquivo') ?? formData.get('file')) as File | null;
      } else {
        body = await req.json();
      }

      const validation = validateBody(criarNfePrestadorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      if (!arquivo || arquivo.size === 0) {
        return errorResponse('Envie o arquivo da NFe (campo "arquivo" ou "file")', 400);
      }

      const prestadorResult = await query(
        `SELECT id, nome_fantasia FROM people.prestadores WHERE id = $1`,
        [data.prestadorId]
      );

      if (prestadorResult.rows.length === 0) {
        return errorResponse('Prestador não encontrado', 404);
      }

      const prestadorId = data.prestadorId;
      const prestadorNome = prestadorResult.rows[0].nome_fantasia as string;
      let contratoNumero: string | null = null;

      if (data.contratoId) {
        const contratoResult = await query(
          `SELECT id, numero FROM people.contratos_prestador WHERE id = $1 AND prestador_id = $2`,
          [data.contratoId, data.prestadorId]
        );
        if (contratoResult.rows.length === 0) {
          return errorResponse('Contrato não encontrado ou não pertence ao prestador', 404);
        }
        contratoNumero = contratoResult.rows[0].numero;
      }

      const buffer = Buffer.from(await arquivo.arrayBuffer());
      const nomeArquivo = arquivo.name || `nfe-${Date.now()}.pdf`;
      const arquivoUrl = await uploadNfePrestador(
        prestadorId,
        prestadorNome,
        buffer,
        arquivo.type || 'application/pdf',
        nomeArquivo
      );

      const numero = data.numero?.trim() || nomeArquivo.replace(/\.[^.]+$/, '') || `nfe-${Date.now()}`;
      const dataEmissao = data.dataEmissao || new Date().toISOString().slice(0, 10);
      const valor = data.valor ?? 0;

      const result = await query(
        `INSERT INTO people.nfes_prestador (
          prestador_id, contrato_id, numero, serie, chave_acesso,
          data_emissao, valor, status, arquivo_url, observacoes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          data.prestadorId,
          data.contratoId || null,
          numero,
          data.serie || null,
          data.chaveAcesso || null,
          dataEmissao,
          valor,
          data.status ?? 'pendente',
          arquivoUrl,
          data.observacoes || null,
        ]
      );

      const row = result.rows[0];
      const novo = {
        id: row.id,
        prestadorId: row.prestador_id,
        prestadorNome,
        contratoId: row.contrato_id,
        contratoNumero,
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

      await invalidateNfePrestadorCache();

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'nfes_prestador',
        descricao: `NFe criada: ${novo.numero} de ${prestadorNome}`,
        entidadeId: novo.id,
        entidadeTipo: 'nfe_prestador',
        dadosNovos: { id: novo.id, numero: novo.numero, prestadorId: novo.prestadorId, valor: novo.valor },
      }));

      return createdResponse(novo);
    } catch (error) {
      console.error('Erro ao criar NFe de prestador:', error);
      return serverErrorResponse('Erro ao criar NFe de prestador');
    }
  });
}
