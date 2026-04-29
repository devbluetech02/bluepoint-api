import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, forbiddenResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';

interface Params {
  params: Promise<{ colaboradorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (_req, user) => {
    try {
      const { colaboradorId: id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const acesso = await asseguraAcessoColaborador(user, colaboradorId);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id, nome, face_registrada FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Buscar dados da biometria
      const biometriaResult = await query(
        `SELECT qualidade, foto_referencia_url, data_cadastro, atualizado_em
         FROM people.biometria_facial
         WHERE colaborador_id = $1`,
        [colaboradorId]
      );

      if (biometriaResult.rows.length === 0) {
        return successResponse({
          colaboradorId,
          cadastrado: false,
          qualidade: null,
          fotoReferencia: null,
          dataCadastro: null,
        });
      }

      const biometria = biometriaResult.rows[0];

      return successResponse({
        colaboradorId,
        cadastrado: true,
        qualidade: parseFloat(biometria.qualidade),
        fotoReferencia: biometria.foto_referencia_url,
        dataCadastro: biometria.data_cadastro,
        atualizadoEm: biometria.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao verificar status:', error);
      return serverErrorResponse('Erro ao verificar status');
    }
  });
}
