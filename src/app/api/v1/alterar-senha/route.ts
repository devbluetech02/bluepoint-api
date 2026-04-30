import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

// senhaAtual é opcional: quando senha_temporaria=true (admin acabou de
// definir/resetar), o usuário escolhe a senha definitiva no primeiro
// acesso sem precisar provar a temporária.
const alterarSenhaSchema = z.object({
  senhaAtual: z.string().optional(),
  novaSenha: z.string().min(6, 'Nova senha deve ter no mínimo 6 caracteres'),
  confirmarSenha: z.string().min(1, 'Confirmação de senha é obrigatória'),
}).refine((data) => data.novaSenha === data.confirmarSenha, {
  message: 'Nova senha e confirmação não conferem',
  path: ['confirmarSenha'],
});

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = alterarSenhaSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { senhaAtual, novaSenha } = validation.data;

      const result = await query<{ senha_hash: string; senha_temporaria: boolean }>(
        `SELECT senha_hash, senha_temporaria FROM people.colaboradores WHERE id = $1`,
        [user.userId]
      );

      if (result.rows.length === 0) {
        return errorResponse('Usuário não encontrado', 404);
      }

      const { senha_hash: senhaHash, senha_temporaria: senhaTemporaria } = result.rows[0];

      if (senhaTemporaria) {
        // Primeiro acesso: ignora senhaAtual. Mas garante que a nova
        // não seja igual à temporária definida pelo admin.
        const igualTemporaria = await verifyPassword(novaSenha, senhaHash);
        if (igualTemporaria) {
          return errorResponse('A nova senha deve ser diferente da senha temporária', 400);
        }
      } else {
        if (!senhaAtual) {
          return errorResponse('Senha atual é obrigatória', 400);
        }
        const senhaCorreta = await verifyPassword(senhaAtual, senhaHash);
        if (!senhaCorreta) {
          return errorResponse('Senha atual incorreta', 400);
        }
        const mesmaSenha = await verifyPassword(novaSenha, senhaHash);
        if (mesmaSenha) {
          return errorResponse('A nova senha deve ser diferente da senha atual', 400);
        }
      }

      const novaSenhaHash = await hashPassword(novaSenha);

      await query(
        `UPDATE people.colaboradores
            SET senha_hash       = $1,
                senha_temporaria = FALSE,
                atualizado_em    = NOW()
          WHERE id = $2`,
        [novaSenhaHash, user.userId]
      );

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'colaboradores',
        descricao: senhaTemporaria
          ? 'Senha definitiva escolhida no primeiro acesso'
          : 'Senha alterada pelo próprio usuário',
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return successResponse({
        mensagem: 'Senha alterada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao alterar senha:', error);
      return serverErrorResponse('Erro ao alterar senha');
    }
  });
}
