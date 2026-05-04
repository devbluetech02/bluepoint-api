import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateCache, CACHE_KEYS } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { z } from 'zod';

const criarCargoSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  cbo: z.string().optional().nullable(),
  descricao: z.string().optional().nullable(),
  salarioPadrao: z.number().min(0).optional().nullable(),
  // Lista de IDs de templates SignProof (globais ou custom) para o envio de
  // contrato de pré-admissão deste cargo. Array vazio = DP escolhe caso a caso.
  templatesContratoAdmissao: z.array(z.string().min(1)).max(20).optional(),
  // ID do template SignProof default usado no contrato de DIA DE TESTE
  // (caminho A do FLUXO_RECRUTAMENTO). Aceita null pra fallback por heurística
  // do nome (vendedor → termo_ciencia, demais → contrato_autonomo).
  templateDiaTeste: z.string().min(1).max(120).optional().nullable(),
  // ID do nível de acesso (people.niveis_acesso). Default = Nível 1 (mais
  // restritivo); o usuário reclassifica conforme necessário.
  nivelAcessoId: z.number().int().min(1).max(3).optional(),
  // Cargo de confiança: colaboradores deste cargo não batem ponto, não
  // recebem push de relatório mensal e ficam fora dos indicadores de
  // horário (visão geral, status tempo real, painel de presença).
  cargoConfianca: z.boolean().optional(),
  // diasTeste foi movido para usuarios_provisorios (task de 2026-04). Zod descarta
  // a chave silenciosamente se o cliente antigo ainda enviar — back-compat.
});

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = criarCargoSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { nome, cbo, descricao, salarioPadrao, templatesContratoAdmissao, templateDiaTeste, nivelAcessoId, cargoConfianca } = validation.data;

      const result = await query(
        `INSERT INTO people.cargos (nome, cbo, descricao, salario_padrao, templates_contrato_admissao, template_dia_teste, nivel_acesso_id, cargo_confianca)
         VALUES ($1, $2, $3, $4, COALESCE($5::text[], ARRAY[]::text[]), $6, COALESCE($7, 1), COALESCE($8, FALSE))
         RETURNING id, nome, nivel_acesso_id, cargo_confianca`,
        [
          nome,
          cbo || null,
          descricao || null,
          salarioPadrao ?? null,
          templatesContratoAdmissao ?? null,
          templateDiaTeste ?? null,
          nivelAcessoId ?? null,
          cargoConfianca ?? null,
        ],
      );

      const cargo = result.rows[0];

      await invalidateCache(CACHE_KEYS.CARGOS);
      await embedTableRowAfterInsert('cargos', cargo.id);

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'cargos',
        descricao: `Cargo criado: ${cargo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: cargo.id, nome, cbo, descricao, salarioPadrao, templatesContratoAdmissao, templateDiaTeste, nivelAcessoId: cargo.nivel_acesso_id, cargoConfianca: cargo.cargo_confianca },
      });

      return createdResponse({
        id: cargo.id,
        nome: cargo.nome,
        nivelAcessoId: cargo.nivel_acesso_id,
        cargoConfianca: cargo.cargo_confianca,
        mensagem: 'Cargo criado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar cargo:', error);
      return serverErrorResponse('Erro ao criar cargo');
    }
  });
}
