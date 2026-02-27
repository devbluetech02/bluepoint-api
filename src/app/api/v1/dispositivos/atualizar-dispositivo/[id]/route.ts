import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

interface Params {
  params: Promise<{ id: string }>;
}

const atualizarDispositivoSchema = z.object({
  nome: z.string().min(3).max(100).optional(),
  descricao: z.string().max(500).optional().nullable(),
  empresaId: z.number().int().positive().optional().nullable(),
  localizacaoId: z.number().int().positive().optional().nullable(),
  status: z.enum(['ativo', 'inativo', 'bloqueado']).optional(),
  permiteEntrada: z.boolean().optional(),
  permiteSaida: z.boolean().optional(),
  requerFoto: z.boolean().optional(),
  requerGeolocalizacao: z.boolean().optional(),
  modelo: z.string().max(100).optional().nullable(),
  sistemaOperacional: z.string().max(50).optional().nullable(),
});

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const dispositivoId = parseInt(id);

      if (isNaN(dispositivoId)) {
        return jsonResponse({
          success: false,
          error: 'ID inválido',
          code: 'INVALID_ID',
        }, 400);
      }

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

      const validation = atualizarDispositivoSchema.safeParse(body);
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

      // Verificar se existe
      const existeResult = await query(
        `SELECT id, nome FROM bluepoint.bt_dispositivos WHERE id = $1`,
        [dispositivoId]
      );

      if (existeResult.rows.length === 0) {
        return jsonResponse({
          success: false,
          error: 'Dispositivo não encontrado',
          code: 'NOT_FOUND',
        }, 404);
      }

      const dispositivoAntigo = existeResult.rows[0];

      // Construir UPDATE dinâmico
      const updates: string[] = [];
      const values: (string | number | boolean | null)[] = [];
      let paramIndex = 1;

      const fieldsMap: Record<string, string> = {
        nome: 'nome',
        descricao: 'descricao',
        empresaId: 'empresa_id',
        localizacaoId: 'localizacao_id',
        status: 'status',
        permiteEntrada: 'permite_entrada',
        permiteSaida: 'permite_saida',
        requerFoto: 'requer_foto',
        requerGeolocalizacao: 'requer_geolocalizacao',
        modelo: 'modelo',
        sistemaOperacional: 'sistema_operacional',
      };

      for (const [key, dbField] of Object.entries(fieldsMap)) {
        if (validation.data[key as keyof typeof validation.data] !== undefined) {
          updates.push(`${dbField} = $${paramIndex++}`);
          values.push(validation.data[key as keyof typeof validation.data] as string | number | boolean | null);
        }
      }

      if (updates.length === 0) {
        return jsonResponse({
          success: false,
          error: 'Nenhum campo para atualizar',
          code: 'NO_UPDATES',
        }, 400);
      }

      updates.push(`atualizado_em = NOW()`);
      values.push(dispositivoId);

      await query(
        `UPDATE bluepoint.bt_dispositivos SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'dispositivos',
        descricao: `Dispositivo atualizado: ${dispositivoAntigo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: dispositivoId, nome: dispositivoAntigo.nome },
        dadosNovos: validation.data,
      });

      return jsonResponse({
        success: true,
        data: {
          id: dispositivoId,
          mensagem: 'Dispositivo atualizado com sucesso',
        },
      });

    } catch (error) {
      console.error('Erro ao atualizar dispositivo:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao atualizar dispositivo',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}
