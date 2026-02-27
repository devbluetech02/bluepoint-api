import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { successResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { uploadArquivo } from '@/lib/storage';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

const assinarRelatorioSchema = z.object({
  colaboradorId: z.number().int().positive('colaboradorId é obrigatório'),
  concordo: z.literal(true, { message: 'É necessário concordar para assinar' }),
  dispositivo: z.string().min(1, 'Dispositivo é obrigatório').max(255),
  localizacao: z.string().max(60).nullable().optional(),
  assinatura: z.string().nullable().optional(),
});

const MAX_ASSINATURA_BASE64_LENGTH = 100_000; // ~75KB decodificado

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (req: NextRequest, user: JWTPayload) => {
    const client = await getClient();

    try {
      const { id } = await params;
      const relatorioId = parseInt(id);
      if (isNaN(relatorioId)) {
        return errorResponse('ID do relatório inválido', 400);
      }

      const body = await req.json();
      const validation = validateBody(assinarRelatorioSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      if (data.assinatura && data.assinatura.length > MAX_ASSINATURA_BASE64_LENGTH) {
        return errorResponse('Imagem da assinatura excede o tamanho máximo permitido (75KB)', 400);
      }

      if (data.assinatura) {
        const base64Regex = /^[A-Za-z0-9+/]+=*$/;
        if (!base64Regex.test(data.assinatura)) {
          return errorResponse('Assinatura deve ser uma string Base64 válida (sem prefixo data:image)', 400);
        }
      }

      const relatorioResult = await query(
        `SELECT id, colaborador_id, mes, ano, status
         FROM bluepoint.bt_relatorios_mensais
         WHERE id = $1`,
        [relatorioId]
      );

      if (relatorioResult.rows.length === 0) {
        return errorResponse('Relatório não encontrado', 404);
      }

      const relatorio = relatorioResult.rows[0];

      if (relatorio.colaborador_id !== data.colaboradorId) {
        return errorResponse('O relatório não pertence a este colaborador', 403);
      }

      if (relatorio.status === 'assinado') {
        return errorResponse('Relatório já foi assinado anteriormente', 400);
      }

      if (relatorio.status !== 'pendente' && relatorio.status !== 'recurso_resolvido') {
        return errorResponse(
          `Relatório não pode ser assinado no status atual: ${relatorio.status}. Status permitidos: pendente, recurso_resolvido`,
          400
        );
      }

      const ipAddress = getClientIp(request);

      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE bluepoint.bt_relatorios_mensais
         SET status = 'assinado',
             assinado_em = NOW(),
             dispositivo = $1,
             localizacao_gps = $2,
             assinatura_imagem = $3,
             ip_address = $4,
             atualizado_em = NOW()
         WHERE id = $5
         RETURNING id, assinado_em`,
        [
          data.dispositivo,
          data.localizacao || null,
          data.assinatura || null,
          ipAddress,
          relatorioId,
        ]
      );

      await client.query('COMMIT');

      const resultado = updateResult.rows[0];

      let assinaturaUrl: string | null = null;
      if (data.assinatura) {
        try {
          const imgBuffer = Buffer.from(data.assinatura, 'base64');
          const caminho = `assinaturas/${data.colaboradorId}/${relatorioId}.png`;
          assinaturaUrl = await uploadArquivo(caminho, imgBuffer, 'image/png');
        } catch (errUpload) {
          console.error('Erro ao salvar imagem da assinatura no MinIO (não bloqueante):', errUpload);
        }
      }

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'relatorios',
        descricao: `Relatório mensal ${relatorio.mes}/${relatorio.ano} assinado pelo colaborador ${data.colaboradorId}`,
        ip: ipAddress,
        userAgent: getUserAgent(request),
        dadosNovos: {
          relatorioId,
          colaboradorId: data.colaboradorId,
          status: 'assinado',
          dispositivo: data.dispositivo,
          localizacao: data.localizacao || null,
          possuiAssinatura: !!data.assinatura,
          ip: ipAddress,
        },
      });

      return successResponse({
        id: resultado.id,
        relatorioId,
        colaboradorId: data.colaboradorId,
        assinadoEm: resultado.assinado_em,
        dispositivo: data.dispositivo,
        localizacao: data.localizacao || null,
        possuiAssinatura: !!data.assinatura,
        imagemUrl: assinaturaUrl,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao assinar relatório mensal:', error);
      return serverErrorResponse('Erro ao assinar relatório');
    } finally {
      client.release();
    }
  });
}
