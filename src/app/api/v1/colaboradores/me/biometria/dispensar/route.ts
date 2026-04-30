import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { withAuth } from '@/lib/middleware';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { calcularBiometriaPrompt } from '@/lib/primeiro-acesso';

/**
 * POST /api/v1/colaboradores/me/biometria/dispensar
 *
 * Registra que o colaborador autenticado escolheu pular o cadastro
 * de biometria facial. Incrementa o contador e atualiza o timestamp;
 * a próxima exibição é controlada por `calcularBiometriaPrompt` (7 dias
 * para o reaviso, e nunca mais após o segundo skip).
 *
 * Sem efeito se o colaborador já tem face cadastrada.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      // API Keys e tokens provisórios não têm registro em colaboradores —
      // o endpoint é só para usuários reais.
      if (user.userId < 0 || user.tipo === 'provisorio') {
        return errorResponse('Endpoint disponível apenas para colaboradores autenticados', 403);
      }

      const result = await query<{
        face_registrada: boolean;
        biometria_dispensas_count: number;
        biometria_dispensada_em: Date | null;
      }>(
        `UPDATE people.colaboradores
            SET biometria_dispensas_count = LEAST(biometria_dispensas_count + 1, 32767),
                biometria_dispensada_em   = NOW(),
                atualizado_em             = NOW()
          WHERE id = $1
          RETURNING face_registrada, biometria_dispensas_count, biometria_dispensada_em`,
        [user.userId]
      );

      if (result.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      const row = result.rows[0];
      const prompt = calcularBiometriaPrompt({
        faceRegistrada: row.face_registrada === true,
        dispensasCount: row.biometria_dispensas_count,
        dispensadaEm: row.biometria_dispensada_em,
      });

      return successResponse({
        biometriaPrompt: prompt,
        dispensasCount: row.biometria_dispensas_count,
      });
    } catch (error) {
      console.error('Erro ao dispensar biometria:', error);
      return serverErrorResponse('Erro ao registrar dispensa de biometria');
    }
  });
}
