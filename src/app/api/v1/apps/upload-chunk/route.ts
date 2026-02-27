import { NextRequest, NextResponse } from 'next/server';
import { withRole } from '@/lib/middleware';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TEMP_DIR = path.join(os.tmpdir(), 'apk-uploads');

// Headers CORS (rota não passa pelo middleware global)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

/**
 * POST /api/v1/apps/upload-chunk
 * Upload de chunk (parte) do APK
 * 
 * Form data:
 * - chunk: arquivo (parte do APK)
 * - uploadId: ID único do upload
 * - chunkIndex: índice do chunk (0, 1, 2...)
 * - totalChunks: total de chunks
 * - fileName: nome do arquivo original
 */
export async function POST(request: NextRequest) {
  console.log('[CHUNK] Recebendo chunk...');
  
  return withRole(request, ['admin'], async (req, user) => {
    try {
      const formData = await req.formData();
      
      const chunk = formData.get('chunk') as File | null;
      const uploadId = formData.get('uploadId') as string | null;
      const chunkIndex = parseInt(formData.get('chunkIndex') as string || '0');
      const totalChunks = parseInt(formData.get('totalChunks') as string || '1');
      const fileName = formData.get('fileName') as string || 'file.apk';
      
      console.log(`[CHUNK] uploadId=${uploadId}, chunk ${chunkIndex + 1}/${totalChunks}`);
      
      if (!chunk || !uploadId) {
        return jsonResponse({
          success: false,
          error: 'Chunk e uploadId são obrigatórios',
          code: 'VALIDATION_ERROR',
        }, 400);
      }
      
      // Criar diretório temporário se não existir
      const uploadDir = path.join(TEMP_DIR, uploadId);
      await fs.mkdir(uploadDir, { recursive: true });
      
      // Salvar chunk
      const chunkPath = path.join(uploadDir, `chunk_${chunkIndex.toString().padStart(5, '0')}`);
      const buffer = Buffer.from(await chunk.arrayBuffer());
      await fs.writeFile(chunkPath, buffer);
      
      // Salvar metadata
      const metaPath = path.join(uploadDir, 'meta.json');
      let meta = {
        fileName,
        totalChunks,
        receivedChunks: [] as number[],
        userId: user.userId,
        createdAt: new Date().toISOString(),
      };
      
      try {
        const existingMeta = await fs.readFile(metaPath, 'utf-8');
        meta = JSON.parse(existingMeta);
      } catch {
        // Arquivo não existe, usar meta inicial
      }
      
      if (!meta.receivedChunks.includes(chunkIndex)) {
        meta.receivedChunks.push(chunkIndex);
      }
      await fs.writeFile(metaPath, JSON.stringify(meta));
      
      const isComplete = meta.receivedChunks.length === totalChunks;
      
      console.log(`[CHUNK] Salvo chunk ${chunkIndex + 1}/${totalChunks}, completo: ${isComplete}`);
      
      return jsonResponse({
        success: true,
        data: {
          uploadId,
          chunkIndex,
          totalChunks,
          receivedChunks: meta.receivedChunks.length,
          isComplete,
        },
        mensagem: `Chunk ${chunkIndex + 1}/${totalChunks} recebido`,
      });
      
    } catch (error) {
      console.error('[CHUNK] Erro:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao processar chunk',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { 
    status: 204,
    headers: corsHeaders,
  });
}
