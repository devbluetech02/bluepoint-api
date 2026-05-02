import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { successResponse, errorResponse, notFoundResponse, serverErrorResponse, forbiddenResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { asseguraAcessoColaborador } from '@/lib/escopo-gestor';
import { z } from 'zod';

const schema = z.object({
  novaSenha: z.string().min(6, 'Nova senha deve ter no mínimo 6 caracteres'),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const acesso = await asseguraAcessoColaborador(user, colaboradorId);
      if (!acesso.permitido) {
        return forbiddenResponse(acesso.motivo ?? 'Acesso negado');
      }

      const body = await req.json();
      const validation = schema.safeParse(body);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message, 400);
      }

      const { novaSenha } = validation.data;

      const result = await query(
        `SELECT id, nome, email FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = result.rows[0];
      const novaSenhaHash = await hashPassword(novaSenha);

      // Marca a senha como temporária — o próprio colaborador será forçado
      // a escolher uma nova no próximo login.
      await query(
        `UPDATE people.colaboradores
            SET senha_hash       = $1,
                senha_temporaria = TRUE,
                atualizado_em    = NOW()
          WHERE id = $2`,
        [novaSenhaHash, colaboradorId]
      );

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'colaboradores',
        descricao: `Senha alterada pelo gestor para o colaborador ${colaborador.nome} (${colaborador.email})`,
        entidadeId: colaboradorId,
        entidadeTipo: 'colaborador',
      }));

      return successResponse({ mensagem: 'Senha alterada com sucesso' });
    } catch (error) {
      console.error('Erro ao alterar senha do colaborador:', error);
      return serverErrorResponse('Erro ao alterar senha');
    }
  });
}
