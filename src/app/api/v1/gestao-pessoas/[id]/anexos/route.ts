import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateGestaoPessoasCache } from '@/lib/cache';
import { getMinioClient, getBucketName, gerarUrlPublica } from '@/lib/storage';
import {
  EXTENSOES_PERMITIDAS,
  MAX_FILE_SIZE,
  detectarTipoAnexo,
  formatAnexo,
} from '@/lib/gestao-pessoas';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const registroId = parseInt(id);
      if (isNaN(registroId)) return notFoundResponse('Registro não encontrado');

      const gpResult = await query(
        `SELECT id FROM bluepoint.bt_gestao_pessoas WHERE id = $1`,
        [registroId]
      );
      if (gpResult.rows.length === 0) return notFoundResponse('Registro não encontrado');

      const formData = await req.formData();
      const anexos = formData.getAll('anexos') as File[];

      if (anexos.length === 0) {
        return errorResponse('Nenhum arquivo enviado', 400);
      }

      for (const anexo of anexos) {
        if (anexo.size > MAX_FILE_SIZE) {
          return errorResponse(`Arquivo "${anexo.name}" excede o limite de 50 MB`, 400);
        }
        const ext = (anexo.name.split('.').pop() || '').toLowerCase();
        if (!EXTENSOES_PERMITIDAS.has(ext)) {
          return errorResponse(`Extensão ".${ext}" não permitida`, 400);
        }
      }

      const minioClient = getMinioClient();
      const bucket = getBucketName();
      const bucketExists = await minioClient.bucketExists(bucket);
      if (!bucketExists) await minioClient.makeBucket(bucket);

      const inseridos = [];

      for (const anexo of anexos) {
        const ext = (anexo.name.split('.').pop() || 'bin').toLowerCase();
        const tipoAnexo = detectarTipoAnexo(ext);
        const storagePath = `gestao-pessoas/${registroId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const buffer = Buffer.from(await anexo.arrayBuffer());

        await minioClient.putObject(bucket, storagePath, buffer, buffer.length, {
          'Content-Type': anexo.type,
        });

        const url = gerarUrlPublica(storagePath);
        const result = await query(
          `INSERT INTO bluepoint.bt_gestao_pessoas_anexos
             (gestao_pessoa_id, nome, tipo, tamanho, url, caminho_storage)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, gestao_pessoa_id, nome, tipo, tamanho, url, criado_em`,
          [registroId, anexo.name, tipoAnexo, anexo.size, url, storagePath]
        );
        inseridos.push(result.rows[0]);
      }

      await invalidateGestaoPessoasCache(registroId);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'criar',
        modulo: 'gestao_pessoas',
        descricao: `${inseridos.length} anexo(s) adicionado(s) ao registro #${registroId}`,
        entidadeId: registroId,
        entidadeTipo: 'gestao_pessoas',
        dadosNovos: { anexos: inseridos.map(a => ({ id: a.id, nome: a.nome })) },
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return createdResponse(inseridos.map((row: any) => formatAnexo(row)));
    } catch (error) {
      console.error('Erro ao adicionar anexos:', error);
      return serverErrorResponse('Erro ao adicionar anexos');
    }
  });
}
