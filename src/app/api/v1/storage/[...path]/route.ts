import { NextRequest, NextResponse } from 'next/server';
import { getMinioClient, getBucketName } from '@/lib/storage';

// Mapeamento de extensões para content-type
const CONTENT_TYPES: Record<string, string> = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

interface Params {
  params: Promise<{ path: string[] }>;
}

/**
 * GET /api/v1/storage/{path}
 * Serve arquivos do MinIO
 * 
 * Exemplo: /api/v1/storage/colaboradores/joao_silva_123/foto.jpg
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { path } = await params;
    
    // Reconstruir o caminho do arquivo
    // O path vem como array: ['colaboradores', 'joao_silva_123', 'foto.jpg']
    const filePath = decodeURIComponent(path.join('/'));

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Caminho do arquivo não especificado' },
        { status: 400 }
      );
    }

    // Verificar se o arquivo existe
    const client = getMinioClient();
    const bucket = getBucketName();
    
    try {
      await client.statObject(bucket, filePath);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Arquivo não encontrado' },
        { status: 404 }
      );
    }

    // Buscar o arquivo do MinIO
    const dataStream = await client.getObject(bucket, filePath);
    
    // Converter stream para buffer
    const chunks: Buffer[] = [];
    for await (const chunk of dataStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Determinar content-type pela extensão
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';

    // Retornar arquivo com headers apropriados
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable', // Cache 1 ano
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('Erro ao servir arquivo:', error);
    return NextResponse.json(
      { success: false, error: 'Erro ao buscar arquivo' },
      { status: 500 }
    );
  }
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
