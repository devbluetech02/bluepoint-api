import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCargoCache } from '@/lib/cache';
import { z } from 'zod';

const atualizarCargoSchema = z.object({
  nome: z.string().min(2).optional(),
  cbo: z.string().optional().nullable(),
  descricao: z.string().optional().nullable(),
  salarioMedio: z.number().min(0, 'Salário médio não pode ser negativo').optional().nullable(),
  valorHoraExtra75: z.number().min(0, 'Valor HE 75% não pode ser negativo').optional().nullable(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const cargoId = parseInt(id);

      if (isNaN(cargoId)) {
        return notFoundResponse('Cargo não encontrado');
      }

      const body = await req.json();
      
      const validation = atualizarCargoSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      // Verificar se existe
      const existeResult = await query(
        `SELECT id, nome, cbo, descricao, salario_medio, valor_hora_extra_75 FROM bluepoint.bt_cargos WHERE id = $1`,
        [cargoId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cargoAntigo = existeResult.rows[0];
      const { nome, cbo, descricao, salarioMedio, valorHoraExtra75 } = validation.data;

      // Construir query de atualização
      const updates: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (nome !== undefined) {
        updates.push(`nome = $${paramIndex}`);
        values.push(nome);
        paramIndex++;
      }
      if (cbo !== undefined) {
        updates.push(`cbo = $${paramIndex}`);
        values.push(cbo);
        paramIndex++;
      }
      if (descricao !== undefined) {
        updates.push(`descricao = $${paramIndex}`);
        values.push(descricao);
        paramIndex++;
      }
      if (salarioMedio !== undefined) {
        updates.push(`salario_medio = $${paramIndex}`);
        values.push(salarioMedio);
        paramIndex++;
      }
      if (valorHoraExtra75 !== undefined) {
        updates.push(`valor_hora_extra_75 = $${paramIndex}`);
        values.push(valorHoraExtra75);
        paramIndex++;
      }

      values.push(cargoId);

      const result = await query(
        `UPDATE bluepoint.bt_cargos SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );

      const cargo = result.rows[0];

      await invalidateCargoCache(cargoId);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'cargos',
        descricao: `Cargo atualizado: ${cargo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: cargoAntigo,
        dadosNovos: { nome, cbo, descricao, salarioMedio, valorHoraExtra75 },
      });

      return successResponse({
        id: cargo.id,
        nome: cargo.nome,
        cbo: cargo.cbo,
        descricao: cargo.descricao,
        salarioMedio: cargo.salario_medio ? parseFloat(cargo.salario_medio) : null,
        valorHoraExtra75: cargo.valor_hora_extra_75 ? parseFloat(cargo.valor_hora_extra_75) : null,
        mensagem: 'Cargo atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar cargo:', error);
      return serverErrorResponse('Erro ao atualizar cargo');
    }
  });
}
