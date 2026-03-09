import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarPrestadorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidatePrestadorCache } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const prestadorId = parseInt(id);

      if (isNaN(prestadorId)) {
        return notFoundResponse('Prestador não encontrado');
      }

      const body = await req.json();

      const validation = validateBody(atualizarPrestadorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const atualResult = await query(
        `SELECT * FROM bluepoint.bt_prestadores WHERE id = $1`,
        [prestadorId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Prestador não encontrado');
      }

      const dadosAnteriores = atualResult.rows[0];

      if (data.cnpjCpf) {
        const cnpjExiste = await query(
          `SELECT id FROM bluepoint.bt_prestadores WHERE cnpj_cpf = $1 AND id != $2`,
          [data.cnpjCpf, prestadorId]
        );
        if (cnpjExiste.rows.length > 0) {
          return errorResponse('CNPJ/CPF já cadastrado em outro prestador', 400);
        }
      }

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      const fieldsMap: Record<string, string> = {
        razaoSocial: 'razao_social',
        nomeFantasia: 'nome_fantasia',
        cnpjCpf: 'cnpj_cpf',
        tipo: 'tipo',
        email: 'email',
        telefone: 'telefone',
        endereco: 'endereco',
        areaAtuacao: 'area_atuacao',
        status: 'status',
        observacoes: 'observacoes',
      };

      for (const [jsField, dbField] of Object.entries(fieldsMap)) {
        if (data[jsField as keyof typeof data] !== undefined) {
          setClauses.push(`${dbField} = $${paramIndex}`);
          values.push(data[jsField as keyof typeof data]);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) {
        return errorResponse('Nenhum campo para atualizar', 400);
      }

      setClauses.push('atualizado_em = NOW()');
      values.push(prestadorId);

      await query(
        `UPDATE bluepoint.bt_prestadores SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      const updatedResult = await query(
        `SELECT * FROM bluepoint.bt_prestadores WHERE id = $1`,
        [prestadorId]
      );
      const row = updatedResult.rows[0];
      const atualizado = {
        id: row.id,
        razaoSocial: row.razao_social,
        nomeFantasia: row.nome_fantasia,
        cnpjCpf: row.cnpj_cpf,
        tipo: row.tipo,
        email: row.email,
        telefone: row.telefone,
        endereco: row.endereco,
        areaAtuacao: row.area_atuacao,
        status: row.status,
        observacoes: row.observacoes,
        createdAt: row.criado_em,
        updatedAt: row.atualizado_em,
      };

      await invalidatePrestadorCache(prestadorId);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'editar',
        modulo: 'prestadores',
        descricao: `Prestador atualizado: ${atualizado.razaoSocial}`,
        entidadeId: prestadorId,
        entidadeTipo: 'prestador',
        dadosAnteriores: { id: prestadorId, ...dadosAnteriores },
        dadosNovos: { id: prestadorId, ...data },
      }));

      return successResponse(atualizado);
    } catch (error) {
      console.error('Erro ao atualizar prestador:', error);
      return serverErrorResponse('Erro ao atualizar prestador');
    }
  });
}
