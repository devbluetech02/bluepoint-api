import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { errorResponse, serverErrorResponse, successResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { gerarLinkFormularioAdmissaoSchema, validateBody } from '@/lib/validation';
import { buildFormularioAdmissaoPublicLink } from '@/lib/formulario-admissao';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const body = await req.json().catch(() => ({}));
      const validation = validateBody(gerarLinkFormularioAdmissaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;
      if (data.id) {
        const existing = await query(
          `SELECT id, token_publico
           FROM people.formularios_admissao
           WHERE id = $1
           LIMIT 1`,
          [data.id]
        );

        if (existing.rows.length === 0) {
          return errorResponse('Formulário de admissão não encontrado', 404);
        }

        let token = existing.rows[0].token_publico as string | null;
        if (!token) {
          token = crypto.randomBytes(24).toString('hex');
          await query(
            `UPDATE people.formularios_admissao
             SET token_publico = $2
             WHERE id = $1`,
            [data.id, token]
          );
        }

        return successResponse({
          link: buildFormularioAdmissaoPublicLink(request, token),
        });
      }

      const latest = await query(
        `SELECT id, token_publico
         FROM people.formularios_admissao
         WHERE ativo = true
         ORDER BY atualizado_em DESC
         LIMIT 1`
      );

      if (latest.rows.length === 0) {
        return errorResponse('Nenhum formulário de admissão ativo encontrado', 404);
      }

      let token = latest.rows[0].token_publico as string | null;
      if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        await query(
          `UPDATE people.formularios_admissao
           SET token_publico = $2
           WHERE id = $1`,
          [latest.rows[0].id, token]
        );
      }

      return successResponse({
        link: buildFormularioAdmissaoPublicLink(request, token),
      });
    } catch (error) {
      console.error('Erro ao gerar link do formulário de admissão:', error);
      return serverErrorResponse('Erro ao gerar link do formulário de admissão');
    }
  });
}
