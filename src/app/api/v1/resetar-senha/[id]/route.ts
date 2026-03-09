import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

const resetarSenhaSchema = z.object({
  novaSenha: z.string().min(6, 'Nova senha deve ter no mínimo 6 caracteres'),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const body = await req.json();
      
      const validation = resetarSenhaSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { novaSenha } = validation.data;

      // Verificar se colaborador existe
      const result = await query(
        `SELECT id, nome FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = result.rows[0];

      // Hash da nova senha
      const novaSenhaHash = await hashPassword(novaSenha);

      // Atualizar senha
      await query(
        `UPDATE bluepoint.bt_colaboradores SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2`,
        [novaSenhaHash, colaboradorId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'colaboradores',
        descricao: `Senha resetada para colaborador: ${colaborador.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { colaboradorId, nome: colaborador.nome },
      });

      return successResponse({
        mensagem: 'Senha resetada com sucesso',
        colaboradorId,
        nome: colaborador.nome,
      });
    } catch (error) {
      console.error('Erro ao resetar senha:', error);
      return serverErrorResponse('Erro ao resetar senha');
    }
  });
}
