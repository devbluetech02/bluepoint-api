import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';
import { invalidateEmpresaCache } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

const criarEmpresaSchema = z.object({
  razaoSocial: z.string().min(1).max(255),
  nomeFantasia: z.string().min(1).max(255),
  cnpj: z.string().min(14).max(18),
  celular: z.string().max(20).optional().nullable(),
  cep: z.string().max(10).optional().nullable(),
  estado: z.string().max(2).optional().nullable(),
  cidade: z.string().max(100).optional().nullable(),
  bairro: z.string().max(100).optional().nullable(),
  rua: z.string().max(255).optional().nullable(),
  numero: z.string().max(20).optional().nullable(),
  // Migration 035: dados consumidos pelo _AdmissaoContratoDialog pra
  // preencher variáveis do contrato (cláusula de foro, signatário,
  // conta pagadora). Todos opcionais — empresa pode configurar aos poucos.
  cidadeForo: z.string().max(120).optional().nullable(),
  signatarioNome: z.string().max(180).optional().nullable(),
  signatarioCargo: z.string().max(120).optional().nullable(),
  bancoPagador: z.string().max(120).optional().nullable(),
  agenciaPagadora: z.string().max(20).optional().nullable(),
  contaPagadora: z.string().max(30).optional().nullable(),
});

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarEmpresaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Limpar CNPJ (remover pontuação)
      const cnpjLimpo = data.cnpj.replace(/[^\d]/g, '');

      // Verificar se CNPJ já existe
      const existeResult = await query(
        `SELECT id FROM people.empresas WHERE cnpj = $1`,
        [cnpjLimpo]
      );

      if (existeResult.rows.length > 0) {
        return errorResponse('CNPJ já cadastrado', 400);
      }

      const result = await query(
        `INSERT INTO people.empresas (
          razao_social, nome_fantasia, cnpj, celular, cep, estado, cidade, bairro, rua, numero,
          cidade_foro, signatario_nome, signatario_cargo,
          banco_pagador, agencia_pagadora, conta_pagadora
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id, razao_social, nome_fantasia, cnpj`,
        [
          data.razaoSocial,
          data.nomeFantasia,
          cnpjLimpo,
          data.celular || null,
          data.cep || null,
          data.estado || null,
          data.cidade || null,
          data.bairro || null,
          data.rua || null,
          data.numero || null,
          data.cidadeForo || null,
          data.signatarioNome || null,
          data.signatarioCargo || null,
          data.bancoPagador || null,
          data.agenciaPagadora || null,
          data.contaPagadora || null,
        ]
      );

      const empresa = result.rows[0];

      await invalidateEmpresaCache();
      await embedTableRowAfterInsert('empresas', empresa.id);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'empresas',
        descricao: `Empresa criada: ${empresa.nome_fantasia}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: empresa.id, razaoSocial: empresa.razao_social, nomeFantasia: empresa.nome_fantasia, cnpj: empresa.cnpj },
      });

      return createdResponse({
        id: empresa.id,
        razaoSocial: empresa.razao_social,
        nomeFantasia: empresa.nome_fantasia,
        cnpj: empresa.cnpj,
        mensagem: 'Empresa criada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar empresa:', error);
      return serverErrorResponse('Erro ao criar empresa');
    }
  });
}
