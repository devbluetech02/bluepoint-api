import { NextRequest, NextResponse } from 'next/server';
import { withRole } from '@/lib/middleware';
import { salvarApk } from '@/lib/storage';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { enviarPushNovaVersao } from '@/lib/push-onesignal';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutos para juntar arquivos grandes

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
 * POST /api/v1/apps/finalize-upload
 * Finaliza upload em chunks - junta os chunks e salva no MinIO
 * 
 * Body JSON:
 * - uploadId: ID único do upload
 * - nome: nome do app
 * - versao: versão (opcional)
 */
export async function POST(request: NextRequest) {
  console.log('[FINALIZE] Iniciando finalização...');
  
  return withRole(request, ['admin'], async (req, user) => {
    try {
      const body = await req.json();
      const { uploadId, nome, versao = null } = body; // versao null = mantém atual
      
      console.log(`[FINALIZE] uploadId=${uploadId}, nome=${nome}, versao=${versao || '(manter atual)'}`);
      
      if (!uploadId || !nome) {
        return jsonResponse({
          success: false,
          error: 'uploadId e nome são obrigatórios',
          code: 'VALIDATION_ERROR',
        }, 400);
      }
      
      const uploadDir = path.join(TEMP_DIR, uploadId);
      const metaPath = path.join(uploadDir, 'meta.json');
      
      // Verificar se upload existe
      try {
        await fs.access(uploadDir);
      } catch {
        return jsonResponse({
          success: false,
          error: 'Upload não encontrado',
          code: 'NOT_FOUND',
        }, 404);
      }
      
      // Ler metadata
      let meta;
      try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        meta = JSON.parse(metaContent);
      } catch {
        return jsonResponse({
          success: false,
          error: 'Metadata do upload não encontrada',
          code: 'NOT_FOUND',
        }, 404);
      }
      
      // Verificar se todos os chunks foram recebidos
      if (meta.receivedChunks.length !== meta.totalChunks) {
        return jsonResponse({
          success: false,
          error: `Upload incompleto: ${meta.receivedChunks.length}/${meta.totalChunks} chunks recebidos`,
          code: 'INCOMPLETE_UPLOAD',
        }, 400);
      }
      
      console.log(`[FINALIZE] Juntando ${meta.totalChunks} chunks...`);
      
      // Juntar chunks
      const chunks: Buffer[] = [];
      for (let i = 0; i < meta.totalChunks; i++) {
        const chunkPath = path.join(uploadDir, `chunk_${i.toString().padStart(5, '0')}`);
        const chunkData = await fs.readFile(chunkPath);
        chunks.push(chunkData);
      }
      
      const completeBuffer = Buffer.concat(chunks);
      console.log(`[FINALIZE] Arquivo completo: ${(completeBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      
      // Salvar no MinIO
      console.log('[FINALIZE] Salvando no MinIO...');
      const resultado = await salvarApk(nome, versao, completeBuffer, meta.fileName);
      console.log('[FINALIZE] Salvo:', resultado.caminho);
      
      // Limpar arquivos temporários
      console.log('[FINALIZE] Limpando arquivos temporários...');
      await fs.rm(uploadDir, { recursive: true, force: true });
      
      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'apps',
        descricao: `APK enviado via chunks: ${nome} v${resultado.versao}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          nome,
          versao: resultado.versao,
          tamanho: completeBuffer.length,
          chunks: meta.totalChunks,
        },
      });
      
      const downloadUrl = `${process.env.BASE_URL || ''}/api/v1/apps/${nome}/download`;
      enviarPushNovaVersao(nome, resultado.versao, downloadUrl).catch(e =>
        console.error('[FINALIZE] Erro ao enviar push nova versao:', e)
      );

      return jsonResponse({
        success: true,
        data: {
          nome,
          versao: resultado.versao,
          url: resultado.url,
          urlDownload: downloadUrl,
          caminho: resultado.caminho,
          tamanho: resultado.tamanho,
          tamanhoFormatado: `${(resultado.tamanho / 1024 / 1024).toFixed(2)} MB`,
          chunks: meta.totalChunks,
        },
        mensagem: 'APK enviado com sucesso via upload em chunks',
      }, 201);
      
    } catch (error) {
      console.error('[FINALIZE] Erro:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao finalizar upload',
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
