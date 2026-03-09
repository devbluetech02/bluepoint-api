import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

const alterarSenhaSchema = z.object({
  senhaAtual: z.string().min(1, 'Senha atual é obrigatória'),
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

      // Buscar senha atual do usuário
      const result = await query(
        `SELECT senha_hash FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [user.userId]
      );

      if (result.rows.length === 0) {
        return errorResponse('Usuário não encontrado', 404);
      }

      const senhaHash = result.rows[0].senha_hash;

      // Verificar senha atual
      const senhaCorreta = await verifyPassword(senhaAtual, senhaHash);
      if (!senhaCorreta) {
        return errorResponse('Senha atual incorreta', 400);
      }

      // Verificar se nova senha é diferente da atual
      const mesmaSenha = await verifyPassword(novaSenha, senhaHash);
      if (mesmaSenha) {
        return errorResponse('A nova senha deve ser diferente da senha atual', 400);
      }

      // Hash da nova senha
      const novaSenhaHash = await hashPassword(novaSenha);

      // Atualizar senha
      await query(
        `UPDATE bluepoint.bt_colaboradores SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2`,
        [novaSenhaHash, user.userId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'colaboradores',
        descricao: 'Senha alterada pelo próprio usuário',
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
