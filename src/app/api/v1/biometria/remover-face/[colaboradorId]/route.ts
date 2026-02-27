import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheDel, CACHE_KEYS } from '@/lib/cache';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return jsonResponse({
          success: false,
          error: 'ID de colaborador inválido',
          code: 'INVALID_ID',
        }, 400);
      }

      // Verificar se existe cadastro
      const existeResult = await query(
        `SELECT bf.id, c.nome 
         FROM bluepoint.bt_biometria_facial bf
         JOIN bluepoint.bt_colaboradores c ON bf.colaborador_id = c.id
         WHERE bf.colaborador_id = $1`,
        [colaboradorId]
      );

      if (existeResult.rows.length === 0) {
        return jsonResponse({
          success: false,
          error: 'Face não cadastrada para este colaborador',
          code: 'NOT_FOUND',
        }, 404);
      }

      const colaborador = existeResult.rows[0];

      // Remover cadastro
      await query(
        `DELETE FROM bluepoint.bt_biometria_facial WHERE colaborador_id = $1`,
        [colaboradorId]
      );

      // Atualizar flag no colaborador
      await query(
        `UPDATE bluepoint.bt_colaboradores SET face_registrada = false, atualizado_em = NOW() WHERE id = $1`,
        [colaboradorId]
      );

      // IMPORTANTE: Invalidar cache de encodings
      await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'biometria',
        descricao: `Face removida de: ${colaborador.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { colaboradorId },
      });

      return jsonResponse({
        success: true,
        data: {
          mensagem: 'Face removida com sucesso',
          colaboradorId,
        },
      });
    } catch (error) {
      console.error('Erro ao remover face:', error);
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
