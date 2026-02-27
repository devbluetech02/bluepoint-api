import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withBiometriaAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ externalId: string }>;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function GET(request: NextRequest, { params }: Params) {
  return withBiometriaAuth(request, async () => {
    try {
      const { externalId } = await params;

      if (!externalId || externalId.length > 100) {
        return jsonResponse({
          success: false,
          error: 'ID externo inválido',
          code: 'INVALID_ID',
        }, 400);
      }

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

      // Buscar biometria onde external_id contém o prefixo e o ID específico
      const biometriaResult = await query(
        `SELECT qualidade, data_cadastro, atualizado_em, external_id
         FROM bluepoint.bt_biometria_facial
         WHERE external_id ? $1 AND external_id ->> $1 = $2`,
        [prefixo, id]
      );

      if (biometriaResult.rows.length === 0) {
        return jsonResponse({
          success: true,
          data: {
            externalId,
            cadastrado: false,
          },
        });
      }

      const biometria = biometriaResult.rows[0];

      return jsonResponse({
        success: true,
        data: {
          externalId,
          cadastrado: true,
          qualidade: parseFloat(biometria.qualidade),
          dataCadastro: biometria.data_cadastro,
          atualizadoEm: biometria.atualizado_em,
          externalIds: biometria.external_id as Record<string, string>, // Retornar todos os IDs externos
        },
      });
    } catch (error) {
      console.error('Erro ao verificar status externo:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao verificar status',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
