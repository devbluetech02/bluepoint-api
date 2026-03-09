import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withBiometriaAuth } from '@/lib/middleware';
import { cacheDel, CACHE_KEYS } from '@/lib/cache';
import { z } from 'zod';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

const removerFaceSchema = z.object({
  externalId: z.string().min(1).max(100),
});

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function DELETE(request: NextRequest) {
  return withBiometriaAuth(request, async (req) => {
    try {
      // Parse body
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

      // Validar request
      const validation = removerFaceSchema.safeParse(body);
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

      const { externalId } = validation.data;

      // Parsear externalId (formato: prefixo_id)
      let prefixo: string;
      let id: string;
      try {
        const parts = externalId.split('_');
        if (parts.length !== 2) {
          throw new Error('Formato inválido');
        }
        prefixo = parts[0];
        id = parts[1];
      } catch (error) {
        return jsonResponse({
          success: false,
          error: 'Formato inválido para externalId. Use formato: prefixo_id',
          code: 'INVALID_EXTERNAL_ID_FORMAT',
        }, 400);
      }

      // Verificar se existe cadastro com este prefixo e ID
      const existeResult = await query(
        `SELECT id, colaborador_id, external_id FROM bluepoint.bt_biometria_facial 
         WHERE external_id ? $1 AND external_id ->> $1 = $2`,
        [prefixo, id]
      );

      if (existeResult.rows.length === 0) {
        return jsonResponse({
          success: false,
          error: 'Face não cadastrada para este ID externo',
          code: 'NOT_FOUND',
        }, 404);
      }

      const registro = existeResult.rows[0];
      const externalIds = registro.external_id as Record<string, string>;

      // Se só tem este external_id e não tem colaborador_id, deletar registro
      if (Object.keys(externalIds).length === 1 && !registro.colaborador_id) {
        await query(`DELETE FROM bluepoint.bt_biometria_facial WHERE id = $1`, [registro.id]);
      } else {
        // Remover apenas esta chave do JSONB
        await query(
          `UPDATE bluepoint.bt_biometria_facial 
           SET external_id = external_id - $1, atualizado_em = NOW()
           WHERE id = $2`,
          [prefixo, registro.id]
        );
      }

      // IMPORTANTE: Invalidar cache de encodings
      await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

      await registrarAuditoria({
        usuarioId: registro.colaborador_id || null,
        acao: 'excluir',
        modulo: 'biometria',
        descricao: `Face externa removida (externalId: ${externalId})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { registroId: registro.id, colaboradorId: registro.colaborador_id, externalId },
      });

      return jsonResponse({
        success: true,
        data: {
          mensagem: 'Face removida com sucesso',
          externalId,
        },
      });
    } catch (error) {
      console.error('Erro ao remover face externa:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao remover face',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
