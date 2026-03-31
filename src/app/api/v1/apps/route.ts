import { NextRequest, NextResponse } from 'next/server';
import { withRole } from '@/lib/middleware';
import { salvarApk, listarArquivos, obterApk } from '@/lib/storage';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { enviarPushNovaVersao } from '@/lib/push-onesignal';

// Route Segment Config - Next.js App Router
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutos de timeout

// Definição dos tipos de apps disponíveis
const APP_TYPES: Record<string, { titulo: string; descricao: string; tipo: string }> = {
  'station': {
    titulo: 'BluePoint Station',
    descricao: 'App para registro de ponto em dispositivos compartilhados',
    tipo: 'station',
  },
  'people-station': {
    titulo: 'BluePoint Station',
    descricao: 'App para registro de ponto em dispositivos compartilhados',
    tipo: 'station',
  },
  'mobile': {
    titulo: 'BluePoint Mobile',
    descricao: 'App para acompanhamento individual do colaborador',
    tipo: 'mobile',
  },
  'people-mobile': {
    titulo: 'BluePoint Mobile',
    descricao: 'App para acompanhamento individual do colaborador',
    tipo: 'mobile',
  },
};

// Headers CORS para rota de apps (não passa pelo middleware global)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
 * GET /api/v1/apps
 * Lista todos os apps disponíveis
 */
export async function GET(request: NextRequest) {
  return withRole(request, ['admin', 'gestor'], async () => {
    try {
      const arquivos = await listarArquivos('apps/');
      
      // Extrair apps únicos que foram enviados
      const appsEnviados = new Set<string>();
      
      for (const arquivo of arquivos) {
        const match = arquivo.match(/^apps\/([^/]+)\//);
        if (match) {
          appsEnviados.add(match[1]);
        }
      }
      
      // Obter detalhes de cada app enviado
      const appsComDetalhes = await Promise.all(
        Array.from(appsEnviados).map(async (nome) => {
          const apk = await obterApk(nome);
          const appInfo = APP_TYPES[nome] || {
            titulo: nome,
            descricao: 'App personalizado',
            tipo: 'custom',
          };
          
          return {
            nome,
            titulo: appInfo.titulo,
            descricao: appInfo.descricao,
            tipo: appInfo.tipo,
            cadastrado: true,
            url: apk?.url || null,
            urlDownload: `${process.env.BASE_URL || ''}/api/v1/apps/${nome}/download`,
          };
        })
      );

      // Criar lista completa incluindo apps não cadastrados ainda
      const tiposBase = ['station', 'mobile'];
      const appsCompletos = tiposBase.map(tipo => {
        // Verificar se já existe (pode ser 'station' ou 'people-station')
        const existente = appsComDetalhes.find(a => 
          a.tipo === tipo || a.nome === tipo || a.nome === `people-${tipo}`
        );
        
        if (existente) {
          return existente;
        }
        
        // App não cadastrado ainda
        const appInfo = APP_TYPES[tipo];
        return {
          nome: tipo,
          titulo: appInfo.titulo,
          descricao: appInfo.descricao,
          tipo: appInfo.tipo,
          cadastrado: false,
          url: null,
          urlDownload: null,
        };
      });

      // Adicionar apps customizados (que não são station nem mobile)
      const appsCustomizados = appsComDetalhes.filter(a => 
        a.tipo === 'custom' || (a.tipo !== 'station' && a.tipo !== 'mobile' && !tiposBase.includes(a.nome))
      );

      return jsonResponse({
        success: true,
        data: {
          apps: [...appsCompletos, ...appsCustomizados],
          tipos: [
            { value: 'station', label: 'BluePoint Station', descricao: 'App para registro de ponto' },
            { value: 'mobile', label: 'BluePoint Mobile', descricao: 'App para acompanhamento individual' },
          ],
        },
        total: appsCompletos.length + appsCustomizados.length,
      });
    } catch (error) {
      console.error('Erro ao listar apps:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao listar apps',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

/**
 * POST /api/v1/apps
 * Upload de APK (substitui se já existir)
 * 
 * Form data:
 * - apk: arquivo APK
 * - nome: nome do app (ex: "ponto_app")
 * - versao: versão (ex: "1.0.0") - opcional, apenas para registro
 */
export async function POST(request: NextRequest) {
  console.log('[APK] Iniciando POST /api/v1/apps');
  console.log('[APK] Content-Type:', request.headers.get('content-type'));
  
  return withRole(request, ['admin'], async (req, user) => {
    console.log('[APK] Autenticado como:', user.nome);
    try {
      console.log('[APK] Processando formData...');
      const formData = await req.formData();
      console.log('[APK] formData processado');
      
      const apkFile = formData.get('apk') as File | null;
      const nome = formData.get('nome') as string | null;
      const versao = formData.get('versao') as string | null; // null = mantém versão atual
      
      // Validações
      if (!apkFile) {
        return jsonResponse({
          success: false,
          error: 'Arquivo APK é obrigatório',
          code: 'VALIDATION_ERROR',
        }, 400);
      }
      
      if (!nome) {
        return jsonResponse({
          success: false,
          error: 'Nome do app é obrigatório',
          code: 'VALIDATION_ERROR',
        }, 400);
      }
      
      // Validar que é um APK
      if (!apkFile.name.endsWith('.apk')) {
        return jsonResponse({
          success: false,
          error: 'O arquivo deve ser um APK (.apk)',
          code: 'VALIDATION_ERROR',
        }, 400);
      }
      
      // Limite de 200MB
      const MAX_SIZE = 200 * 1024 * 1024;
      if (apkFile.size > MAX_SIZE) {
        return jsonResponse({
          success: false,
          error: `Arquivo muito grande. Máximo: ${MAX_SIZE / 1024 / 1024}MB`,
          code: 'FILE_TOO_LARGE',
        }, 400);
      }
      
      // Converter para buffer
      console.log('[APK] Convertendo para buffer...');
      const arrayBuffer = await apkFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log('[APK] Buffer size:', buffer.length, 'bytes');
      
      // Salvar APK (substitui se existir)
      console.log('[APK] Salvando no MinIO...');
      const resultado = await salvarApk(nome, versao, buffer, apkFile.name);
      console.log('[APK] Salvo com sucesso:', resultado.caminho);
      
      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'apps',
        descricao: `APK enviado: ${nome} v${resultado.versao} (substituiu anterior se existia)`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          nome,
          versao: resultado.versao,
          tamanho: buffer.length,
          arquivo: apkFile.name,
        },
      });

      const downloadUrl = `${process.env.BASE_URL || ''}/api/v1/apps/${nome}/download`;
      enviarPushNovaVersao(nome, resultado.versao, downloadUrl).catch(e =>
        console.error('[APK] Erro ao enviar push nova versao:', e)
      );

      return jsonResponse({
        success: true,
        data: {
          nome,
          versao: resultado.versao,
          url: resultado.url,
          urlDownload: `${process.env.BASE_URL || ''}/api/v1/apps/${nome}/download`,
          caminho: resultado.caminho,
          tamanho: resultado.tamanho,
          tamanhoFormatado: `${(resultado.tamanho / 1024 / 1024).toFixed(2)} MB`,
        },
        mensagem: 'APK enviado com sucesso (substituiu anterior se existia)',
      }, 201);
      
    } catch (error) {
      console.error('Erro ao enviar APK:', error);
      return jsonResponse({
        success: false,
        error: 'Erro ao enviar APK',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// OPTIONS para CORS (importante pois esta rota não passa pelo middleware global)
export async function OPTIONS() {
  return new NextResponse(null, { 
    status: 204,
    headers: corsHeaders,
  });
}
