import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';
import crypto from 'crypto';
import { invalidateDispositivoCache } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

const criarDispositivoSchema = z.object({
  nome: z.string().min(3).max(100),
  descricao: z.string().max(500).optional().nullable(),
  empresaId: z.number().int().positive().optional().nullable(),
  localizacaoId: z.number().int().positive().optional().nullable(),
  permiteEntrada: z.boolean().optional().default(true),
  permiteSaida: z.boolean().optional().default(true),
  requerFoto: z.boolean().optional().default(true),
  requerGeolocalizacao: z.boolean().optional().default(false),
  modelo: z.string().max(100).optional().nullable(),
  sistemaOperacional: z.string().max(50).optional().nullable(),
});

// Gera código único do dispositivo (6 dígitos alfanuméricos)
function gerarCodigoDispositivo(): string {
  const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sem I, O, 0, 1 para evitar confusão
  let codigo = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    codigo += caracteres[bytes[i] % caracteres.length];
  }
  return codigo;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({
          success: false,
          error: 'JSON inválido',
          code: 'INVALID_JSON',
        }, 400);
      }

      const validation = criarDispositivoSchema.safeParse(body);
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

      const {
        nome,
        descricao,
        empresaId,
        localizacaoId,
        permiteEntrada,
        permiteSaida,
        requerFoto,
        requerGeolocalizacao,
        modelo,
        sistemaOperacional,
      } = validation.data;

      // Gerar código único
      const codigo = gerarCodigoDispositivo();

      // Inserir dispositivo
      const result = await query(
        `INSERT INTO people.dispositivos (
          codigo, nome, descricao, empresa_id, localizacao_id,
          permite_entrada, permite_saida, requer_foto, requer_geolocalizacao,
          modelo, sistema_operacional, criado_por
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, codigo, nome`,
        [
          codigo,
          nome,
          descricao || null,
          empresaId || null,
          localizacaoId || null,
          permiteEntrada,
          permiteSaida,
          requerFoto,
          requerGeolocalizacao,
          modelo || null,
          sistemaOperacional || null,
          user.userId,
        ]
      );

      const dispositivo = result.rows[0];

      await invalidateDispositivoCache();
      await embedTableRowAfterInsert('dispositivos', dispositivo.id);

      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'dispositivos',
        descricao: `Dispositivo criado: ${nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: dispositivo.id, nome, codigo },
      });

      return jsonResponse({
        success: true,
        data: {
          id: dispositivo.id,
          codigo: dispositivo.codigo,
          nome: dispositivo.nome,
          mensagem: 'Dispositivo criado com sucesso',
        },
      }, 201);

    } catch (error) {
      console.error('Erro ao criar dispositivo:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao criar dispositivo',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}
