import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCargoCache } from '@/lib/cache';
import { z } from 'zod';

const UFS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
] as const;

const overrideSchema = z
  .object({
    uf: z.enum(UFS),
    salario: z.number().min(0, 'Salário não pode ser negativo').nullable().optional(),
    jornadaId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (v) => (v.salario != null) || (v.jornadaId != null),
    { message: 'Cada UF deve ter ao menos salário ou jornada definidos.' },
  );

const bulkSchema = z.object({
  overrides: z.array(overrideSchema),
});

interface Params {
  params: Promise<{ cargoId: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    const { cargoId: cargoIdParam } = await params;
    const cargoId = parseInt(cargoIdParam);
    if (isNaN(cargoId)) return notFoundResponse('Cargo não encontrado');

    const body = await req.json();
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      const errors: Record<string, string[]> = {};
      parsed.error.issues.forEach((issue) => {
        const path = issue.path.join('.') || 'geral';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      });
      return validationErrorResponse(errors);
    }

    // UFs duplicadas no payload são erro de cliente — refuse explicitamente em vez
    // de deixar o ON CONFLICT mascarar perda de dados.
    const ufs = parsed.data.overrides.map((o) => o.uf);
    const ufsUnicas = new Set(ufs);
    if (ufsUnicas.size !== ufs.length) {
      return validationErrorResponse({ overrides: ['UFs duplicadas no payload.'] });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const existe = await client.query<{ id: number }>(
        'SELECT id FROM people.cargos WHERE id = $1',
        [cargoId],
      );
      if (existe.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFoundResponse('Cargo não encontrado');
      }

      // Snapshot pra auditoria
      const antes = await client.query(
        `SELECT uf, salario, jornada_id
           FROM people.cargos_uf
          WHERE cargo_id = $1
          ORDER BY uf`,
        [cargoId],
      );

      // 1) Apaga UFs que sumiram do payload
      if (ufs.length > 0) {
        await client.query(
          `DELETE FROM people.cargos_uf
            WHERE cargo_id = $1
              AND uf <> ALL($2::varchar[])`,
          [cargoId, ufs],
        );
      } else {
        await client.query(
          'DELETE FROM people.cargos_uf WHERE cargo_id = $1',
          [cargoId],
        );
      }

      // 2) Upsert das UFs do payload
      for (const o of parsed.data.overrides) {
        await client.query(
          `INSERT INTO people.cargos_uf (cargo_id, uf, salario, jornada_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (cargo_id, uf)
           DO UPDATE SET
             salario       = EXCLUDED.salario,
             jornada_id    = EXCLUDED.jornada_id,
             atualizado_em = NOW()`,
          [cargoId, o.uf, o.salario ?? null, o.jornadaId ?? null],
        );
      }

      const depois = await client.query(
        `SELECT uf, salario, jornada_id, criado_em, atualizado_em
           FROM people.cargos_uf
          WHERE cargo_id = $1
          ORDER BY uf`,
        [cargoId],
      );

      await client.query('COMMIT');

      await invalidateCargoCache(cargoId);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'cargos',
        descricao: `Variações por UF atualizadas no cargo #${cargoId}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { overrides: antes.rows },
        dadosNovos: { overrides: depois.rows },
      });

      return successResponse({
        cargoId,
        overrides: depois.rows.map((r) => ({
          uf: r.uf,
          salario: r.salario != null ? parseFloat(r.salario) : null,
          jornadaId: r.jornada_id,
          criadoEm: r.criado_em,
          atualizadoEm: r.atualizado_em,
        })),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Erro ao atualizar cargo_uf:', error);
      return serverErrorResponse('Erro ao atualizar variações por UF do cargo');
    } finally {
      client.release();
    }
  });
}
