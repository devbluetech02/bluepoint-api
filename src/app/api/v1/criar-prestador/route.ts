import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarPrestadorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidatePrestadorCache } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(criarPrestadorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const existeResult = await query(
        `SELECT id FROM bluepoint.bt_prestadores WHERE cnpj_cpf = $1`,
        [data.cnpjCpf]
      );

      if (existeResult.rows.length > 0) {
        return errorResponse('CNPJ/CPF já cadastrado', 400);
      }

      const result = await query(
        `INSERT INTO bluepoint.bt_prestadores (
          razao_social, nome_fantasia, cnpj_cpf, tipo, email, telefone,
          endereco, area_atuacao, status, observacoes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          data.razaoSocial,
          data.nomeFantasia || null,
          data.cnpjCpf,
          data.tipo,
          data.email || null,
          data.telefone || null,
          data.endereco || null,
          data.areaAtuacao || null,
          data.status ?? 'ativo',
          data.observacoes || null,
        ]
      );

      const row = result.rows[0];
      const novo = {
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

      await invalidatePrestadorCache();
      await embedTableRowAfterInsert('bt_prestadores', novo.id);

      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'prestadores',
        descricao: `Prestador criado: ${novo.razaoSocial}`,
        entidadeId: novo.id,
        entidadeTipo: 'prestador',
        dadosNovos: { id: novo.id, razaoSocial: novo.razaoSocial, cnpjCpf: novo.cnpjCpf },
      }));

      return createdResponse(novo);
    } catch (error) {
      console.error('Erro ao criar prestador:', error);
      return serverErrorResponse('Erro ao criar prestador');
    }
  });
}
