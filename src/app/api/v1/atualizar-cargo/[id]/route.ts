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
  // Lista de IDs de templates SignProof associados a este cargo (migration 033).
  // Array vazio = DP escolhe caso a caso; undefined = não mexe.
  templatesContratoAdmissao: z.array(z.string().min(1)).max(20).optional(),
  // diasTeste foi movido para usuarios_provisorios. Zod descarta silenciosamente.
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
        `SELECT id, nome, cbo, descricao, salario_medio, templates_contrato_admissao
           FROM people.cargos WHERE id = $1`,
        [cargoId]
      );

      if (existeResult.rows.length === 0) {
        return notFoundResponse('Cargo não encontrado');
      }

      const cargoAntigo = existeResult.rows[0];
      const { nome, cbo, descricao, salarioMedio, templatesContratoAdmissao } = validation.data;

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
      if (templatesContratoAdmissao !== undefined) {
        updates.push(`templates_contrato_admissao = $${paramIndex}::text[]`);
        values.push(templatesContratoAdmissao);
        paramIndex++;
      }

      values.push(cargoId);

      const result = await query(
        `UPDATE people.cargos SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );

      const cargo = result.rows[0];

      await invalidateCargoCache(cargoId);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'cargos',
        descricao: `Cargo atualizado: ${cargo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: cargoAntigo,
        dadosNovos: { nome, cbo, descricao, salarioMedio },
      });

      return successResponse({
        id: cargo.id,
        nome: cargo.nome,
        cbo: cargo.cbo,
        descricao: cargo.descricao,
        salarioMedio: cargo.salario_medio ? parseFloat(cargo.salario_medio) : null,
        templatesContratoAdmissao: cargo.templates_contrato_admissao ?? [],
        mensagem: 'Cargo atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar cargo:', error);
      return serverErrorResponse('Erro ao atualizar cargo');
    }
  });
}
