import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { getMinioClient, getBucketName, gerarUrlPublica } from '@/lib/storage';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const formData = await req.formData();
      const arquivo = formData.get('arquivo') as File | null;
      const tipo = formData.get('tipo') as string || 'documento';
      const descricao = formData.get('descricao') as string || '';

      if (!arquivo) {
        return errorResponse('Arquivo não fornecido', 400);
      }

      // Validar tamanho (máx 10MB)
      if (arquivo.size > 10 * 1024 * 1024) {
        return errorResponse('Arquivo muito grande. Máximo 10MB.', 400);
      }

      // Gerar nome do arquivo
      const extension = arquivo.name.split('.').pop() || 'bin';
      const fileName = `anexos/${user.userId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${extension}`;

      // Upload para MinIO
      const buffer = Buffer.from(await arquivo.arrayBuffer());
      const client = getMinioClient();
      const bucket = getBucketName();
      
      const bucketExists = await client.bucketExists(bucket);
      if (!bucketExists) {
        await client.makeBucket(bucket);
      }

      await client.putObject(bucket, fileName, buffer, buffer.length, {
        'Content-Type': arquivo.type,
      });

      // Gerar URL pública via proxy
      const url = gerarUrlPublica(fileName);

      // Salvar no banco
      const result = await query(
        `INSERT INTO bt_anexos (colaborador_id, tipo, nome, url, tamanho, descricao)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, nome, tipo, tamanho, url`,
        [user.userId, tipo, arquivo.name, url, arquivo.size, descricao]
      );

      const anexo = result.rows[0];
      embedTableRowAfterInsert('bt_anexos', anexo.id).catch(() => {});

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'anexos',
        descricao: `Anexo #${anexo.id} enviado (${arquivo.name})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: anexo.id, nome: anexo.nome, tipo: anexo.tipo, tamanho: anexo.tamanho, url: anexo.url },
      });

      return createdResponse({
        id: anexo.id,
        nome: anexo.nome,
        tipo: anexo.tipo,
        tamanho: anexo.tamanho,
        url: anexo.url,
        mensagem: 'Anexo enviado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao enviar anexo:', error);
      return serverErrorResponse('Erro ao enviar anexo');
    }
  });
}
