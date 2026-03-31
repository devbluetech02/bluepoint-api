import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { z } from 'zod';
import { registrarAuditoria, getUserAgent } from '@/lib/audit';

const ativarDispositivoSchema = z.object({
  codigo: z.string().min(6).max(6).toUpperCase(),
  modelo: z.string().max(100).optional(),
  sistemaOperacional: z.string().max(50).optional(),
  versaoApp: z.string().max(20).optional(),
});

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');
  
  if (cfIp) return cfIp;
  if (forwarded) return forwarded.split(',')[0].trim();
  if (realIp) return realIp;
  
  return 'unknown';
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Endpoint para ativar/validar um dispositivo
 * O app mobile chama este endpoint na inicialização para validar o código
 */
export async function POST(request: NextRequest) {
  try {
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

    const validation = ativarDispositivoSchema.safeParse(body);
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

    const { codigo, modelo, sistemaOperacional, versaoApp } = validation.data;
    const clientIp = getClientIp(request);

    // Buscar dispositivo pelo código
    const result = await query(
      `SELECT 
        d.id, d.nome, d.status, d.permite_entrada, d.permite_saida,
        d.requer_foto, d.requer_geolocalizacao,
        e.id as empresa_id, e.nome_fantasia as empresa_nome,
        l.id as localizacao_id, l.nome as localizacao_nome,
        l.latitude, l.longitude, l.raio_permitido
      FROM people.dispositivos d
      LEFT JOIN people.empresas e ON d.empresa_id = e.id
      LEFT JOIN people.localizacoes l ON d.localizacao_id = l.id
      WHERE d.codigo = $1`,
      [codigo]
    );

    if (result.rows.length === 0) {
      return jsonResponse({
        success: false,
        error: 'Código de dispositivo inválido',
        code: 'INVALID_DEVICE_CODE',
      }, 401);
    }

    const dispositivo = result.rows[0];

    // Verificar status
    if (dispositivo.status === 'inativo') {
      return jsonResponse({
        success: false,
        error: 'Dispositivo inativo. Contate o administrador.',
        code: 'DEVICE_INACTIVE',
      }, 403);
    }

    if (dispositivo.status === 'bloqueado') {
      return jsonResponse({
        success: false,
        error: 'Dispositivo bloqueado. Contate o administrador.',
        code: 'DEVICE_BLOCKED',
      }, 403);
    }

    // Atualizar informações do dispositivo
    await query(
      `UPDATE people.dispositivos SET
        modelo = COALESCE($1, modelo),
        sistema_operacional = COALESCE($2, sistema_operacional),
        versao_app = COALESCE($3, versao_app),
        ultimo_acesso = NOW(),
        ip_ultimo_acesso = $4,
        atualizado_em = NOW()
      WHERE id = $5`,
      [modelo || null, sistemaOperacional || null, versaoApp || null, clientIp, dispositivo.id]
    );

    await registrarAuditoria({
      usuarioId: null,
      acao: 'editar',
      modulo: 'dispositivos',
      descricao: `Dispositivo #${dispositivo.id} (${dispositivo.nome}) ativado via código ${codigo}`,
      ip: clientIp,
      userAgent: getUserAgent(request),
      dadosNovos: { dispositivoId: dispositivo.id, nome: dispositivo.nome, modelo, sistemaOperacional, versaoApp },
    });

    return jsonResponse({
      success: true,
      data: {
        ativado: true,
        dispositivo: {
          id: dispositivo.id,
          nome: dispositivo.nome,
          permiteEntrada: dispositivo.permite_entrada,
          permiteSaida: dispositivo.permite_saida,
          requerFoto: dispositivo.requer_foto,
          requerGeolocalizacao: dispositivo.requer_geolocalizacao,
        },
        empresa: dispositivo.empresa_id ? {
          id: dispositivo.empresa_id,
          nome: dispositivo.empresa_nome,
        } : null,
        localizacao: dispositivo.localizacao_id ? {
          id: dispositivo.localizacao_id,
          nome: dispositivo.localizacao_nome,
          latitude: dispositivo.latitude ? parseFloat(dispositivo.latitude) : null,
          longitude: dispositivo.longitude ? parseFloat(dispositivo.longitude) : null,
          raioPermitido: dispositivo.raio_permitido,
        } : null,
        mensagem: 'Dispositivo ativado com sucesso',
      },
    });

  } catch (error) {
    console.error('Erro ao ativar dispositivo:', error);
    return jsonResponse({
      success: false,
      error: 'Erro interno ao ativar dispositivo',
      code: 'INTERNAL_ERROR',
    }, 500);
  }
}

// OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
