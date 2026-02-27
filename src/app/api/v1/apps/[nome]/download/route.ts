import { NextRequest, NextResponse } from 'next/server';
import { obterApk } from '@/lib/storage';

interface Params {
  params: Promise<{ nome: string }>;
}

/**
 * GET /api/v1/apps/{nome}/download
 * Download público do APK (sem autenticação)
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { nome } = await params;
    
    const apk = await obterApk(nome);
    
    if (!apk) {
      return NextResponse.json({
        success: false,
        error: `App ${nome} não encontrado`,
        code: 'NOT_FOUND',
      }, { status: 404 });
    }
    
    // Redirecionar para a URL do arquivo
    return NextResponse.redirect(apk.url);
    
  } catch (error) {
    console.error('Erro ao baixar APK:', error);
    return NextResponse.json({
      success: false,
      error: 'Erro ao baixar APK',
      code: 'INTERNAL_ERROR',
    }, { status: 500 });
  }
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { 
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
