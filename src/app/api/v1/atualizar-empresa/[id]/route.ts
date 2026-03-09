import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

const atualizarEmpresaSchema = z.object({
  razaoSocial: z.string().min(1).max(255).optional(),
  nomeFantasia: z.string().min(1).max(255).optional(),
  cnpj: z.string().min(14).max(18).optional(),
  celular: z.string().max(20).optional().nullable(),
  cep: z.string().max(10).optional().nullable(),
  estado: z.string().max(2).optional().nullable(),
  cidade: z.string().max(100).optional().nullable(),
  bairro: z.string().max(100).optional().nullable(),
  rua: z.string().max(255).optional().nullable(),
  numero: z.string().max(20).optional().nullable(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const empresaId = parseInt(id);

      if (isNaN(empresaId)) {
        return notFoundResponse('Empresa não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarEmpresaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se empresa existe
      const empresaAtual = await query(
        `SELECT * FROM bluepoint.bt_empresas WHERE id = $1`,
        [empresaId]
      );

      if (empresaAtual.rows.length === 0) {
        return notFoundResponse('Empresa não encontrada');
      }

      const dadosAnteriores = empresaAtual.rows[0];

      // Se estiver atualizando CNPJ, verificar duplicidade
      if (data.cnpj) {
        const cnpjLimpo = data.cnpj.replace(/[^\d]/g, '');
        const existeResult = await query(
          `SELECT id FROM bluepoint.bt_empresas WHERE cnpj = $1 AND id != $2`,
          [cnpjLimpo, empresaId]
        );

        if (existeResult.rows.length > 0) {
          return errorResponse('CNPJ já cadastrado em outra empresa', 400);
        }
      }

      // Montar query de update dinamicamente
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      const campos: { [key: string]: string } = {
        razaoSocial: 'razao_social',
        nomeFantasia: 'nome_fantasia',
        cnpj: 'cnpj',
        celular: 'celular',
        cep: 'cep',
        estado: 'estado',
        cidade: 'cidade',
        bairro: 'bairro',
        rua: 'rua',
        numero: 'numero',
      };

      for (const [key, dbColumn] of Object.entries(campos)) {
        if (data[key as keyof typeof data] !== undefined) {
          let value = data[key as keyof typeof data];
          
          // Limpar CNPJ se for o campo
          if (key === 'cnpj' && typeof value === 'string') {
            value = value.replace(/[^\d]/g, '');
          }
          
          updates.push(`${dbColumn} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      }

      if (updates.length === 0) {
        return errorResponse('Nenhum campo para atualizar', 400);
      }

      updates.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(empresaId);

      const result = await query(
        `UPDATE bluepoint.bt_empresas 
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, razao_social, nome_fantasia, cnpj`,
        values
      );

      const empresa = result.rows[0];

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'empresas',
        descricao: `Empresa atualizada: ${empresa.nome_fantasia}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { 
          razaoSocial: dadosAnteriores.razao_social, 
          nomeFantasia: dadosAnteriores.nome_fantasia, 
          cnpj: dadosAnteriores.cnpj 
        },
        dadosNovos: { 
          razaoSocial: empresa.razao_social, 
          nomeFantasia: empresa.nome_fantasia, 
          cnpj: empresa.cnpj 
        },
      });

      return successResponse({
        id: empresa.id,
        razaoSocial: empresa.razao_social,
        nomeFantasia: empresa.nome_fantasia,
        cnpj: empresa.cnpj,
        mensagem: 'Empresa atualizada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar empresa:', error);
      return serverErrorResponse('Erro ao atualizar empresa');
    }
  });
}
