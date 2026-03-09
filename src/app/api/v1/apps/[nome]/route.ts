import { NextRequest, NextResponse } from 'next/server';
import { withAdmin, withAuth } from '@/lib/middleware';
import { obterApk, deletarApk } from '@/lib/storage';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ nome: string }>;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * GET /api/v1/apps/{nome}
 * Obtém informações de um app específico
 */
export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { nome } = await params;
      
      const apk = await obterApk(nome);
      
      if (!apk) {
        return jsonResponse({
          success: false,
          error: 'App não encontrado',
          code: 'NOT_FOUND',
        }, 404);
      }

      return jsonResponse({
        success: true,
        data: {
          nome,
          versao: apk.versao,
          url: apk.url,
          urlDownload: `${process.env.BASE_URL || ''}/api/v1/apps/${nome}/download`,
          caminho: apk.caminho,
          tamanho: apk.tamanho,
          tamanhoFormatado: apk.tamanho ? `${(apk.tamanho / 1024 / 1024).toFixed(2)} MB` : null,
          atualizadoEm: apk.atualizadoEm,
        },
      });
    } catch (error) {
      console.error('Erro ao obter app:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao obter app',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

/**
 * DELETE /api/v1/apps/{nome}
 * Deleta o APK do app
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { nome } = await params;
      
      // Deletar APK
      await deletarApk(nome);
      
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'apps',
        descricao: `APK deletado: ${nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { nome },
      });
      
      return jsonResponse({
        success: true,
        mensagem: `App ${nome} deletado com sucesso`,
      });
    } catch (error) {
      console.error('Erro ao deletar app:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao deletar app',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { 
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
