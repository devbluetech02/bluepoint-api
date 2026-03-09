import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { uploadArquivo } from '@/lib/storage';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

const salvarFotoSchema = z.object({
  colaboradorId: z.number().int().positive(),
  imagem: z.string().min(100, 'Imagem inválida'),
  // Metadados opcionais
  tipo: z.enum(['reconhecimento', 'ponto']).optional().default('reconhecimento'),
  marcacaoId: z.number().int().positive().optional(),
  dispositivoId: z.number().int().positive().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({
        success: false,
        error: 'JSON inválido',
        code: 'INVALID_JSON',
      }, 400);
    }

    // Validar request
    const validation = salvarFotoSchema.safeParse(body);
    if (!validation.success) {
      return jsonResponse({
        success: false,
        error: 'Erro de validação',
        code: 'VALIDATION_ERROR',
        details: validation.error.issues.map(i => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      }, 422);
    }

    const { colaboradorId, imagem, tipo, marcacaoId, dispositivoId, latitude, longitude } = validation.data;

    // Buscar dados do colaborador
    const colaboradorResult = await query(
      `SELECT id, nome FROM bluepoint.bt_colaboradores WHERE id = $1`,
      [colaboradorId]
    );

    if (colaboradorResult.rows.length === 0) {
      return jsonResponse({
        success: false,
        error: 'Colaborador não encontrado',
        code: 'COLLABORATOR_NOT_FOUND',
      }, 404);
    }

    const colaborador = colaboradorResult.rows[0];

    // Processar imagem base64
    const base64Data = imagem.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Detectar tipo de imagem (padrão: jpeg)
    let extensao = 'jpg';
    let contentType = 'image/jpeg';
    
    if (imagem.startsWith('data:image/png')) {
      extensao = 'png';
      contentType = 'image/png';
    } else if (imagem.startsWith('data:image/webp')) {
      extensao = 'webp';
      contentType = 'image/webp';
    }

    // Gerar nome único para o arquivo com data e hora (fuso horário Brasil)
    const agora = new Date();
    const opcoesBrasil = { timeZone: 'America/Sao_Paulo' };
    
    // Formatar data: YYYY-MM-DD
    const dataFormatada = agora.toLocaleDateString('sv-SE', opcoesBrasil); // sv-SE retorna YYYY-MM-DD
    
    // Formatar hora: HH-MM-SS
    const horaFormatada = agora.toLocaleTimeString('pt-BR', { 
      ...opcoesBrasil, 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(/:/g, '-');
    
    const nomeArquivo = `${dataFormatada}_${horaFormatada}`; // 2026-01-30_10-30-45
    
    // Estrutura: reconhecimentos/{colaboradorId}/{data}/{data_hora}.{ext}
    const caminho = `reconhecimentos/${colaboradorId}/${dataFormatada}/${nomeArquivo}.${extensao}`;

    // Upload para MinIO
    const url = await uploadArquivo(caminho, buffer, contentType);

    // Salvar registro no banco (opcional - para rastreabilidade)
    let registroId: number | null = null;
    try {
      const insertResult = await query(
        `INSERT INTO bluepoint.bt_fotos_reconhecimento (
          colaborador_id, url, caminho_storage, tipo, marcacao_id, 
          dispositivo_id, latitude, longitude, tamanho_bytes, criado_em
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING id`,
        [
          colaboradorId,
          url,
          caminho,
          tipo,
          marcacaoId || null,
          dispositivoId || null,
          latitude || null,
          longitude || null,
          buffer.length,
        ]
      );
      registroId = insertResult.rows[0]?.id;
    } catch (dbError) {
      // Se a tabela não existir, apenas loga o erro mas continua
      // A foto foi salva no MinIO de qualquer forma
      console.warn('[Salvar Foto] Tabela bt_fotos_reconhecimento não existe ou erro ao inserir:', dbError);
    }

    await registrarAuditoria({
      usuarioId: colaboradorId,
      acao: 'criar',
      modulo: 'biometria',
      descricao: `Foto de reconhecimento salva para colaborador #${colaboradorId} (${colaborador.nome})`,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      dadosNovos: { registroId, colaboradorId, url, caminho, tipo, tamanhoBytes: buffer.length },
    });

    return jsonResponse({
      success: true,
      data: {
        id: registroId,
        colaboradorId,
        url,
        caminho,
        tipo,
        tamanhoBytes: buffer.length,
        processedIn: Date.now() - startTime,
      },
    });

  } catch (error) {
    console.error('Erro ao salvar foto de reconhecimento:', error);
    return jsonResponse({
      success: false,
      error: 'Erro interno ao salvar foto',
      code: 'INTERNAL_ERROR',
    }, 500);
  }
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
