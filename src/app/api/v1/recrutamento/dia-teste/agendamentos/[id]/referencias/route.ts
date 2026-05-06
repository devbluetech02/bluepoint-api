import { NextRequest } from 'next/server';
import { z } from 'zod';
import { query, queryRecrutamento, queryRecrutamentoWrite } from '@/lib/db';
import { withAdmissao } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { criarOuReaproveitarProvisorio } from '@/lib/usuarios-provisorios';
import { loadAgendamento } from '../_helpers';

// POST /api/v1/recrutamento/dia-teste/agendamentos/:id/referencias
//
// Após o gestor aprovar+encerrar o dia de teste, o processo fica em
// 'coletar_referencias'. RH preenche 2 referências do candidato (nome
// + telefone, descrição opcional) e chama este endpoint.
//
// Efeitos:
//  1. UPDATE public.candidatos no banco Recrutamento gravando referências
//     nos slots 1 e 2 (nome_referencia / telefone_referencia / descricao_*
//     / status_*).
//  2. Cria usuario_provisorio + solicitacao_admissao (mesmo trilho do
//     /aprovar antigo) e linka ao processo_seletivo.
//  3. Move processo_seletivo: 'coletar_referencias' -> 'pre_admissao'.
//
// Body: { referencias: [{nome, telefone, descricao?}, {nome, telefone, descricao?}] }

const referenciaSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  telefone: z.string().trim().min(8).max(20),
  descricao: z.string().trim().max(500).optional(),
});

const schema = z.object({
  referencias: z.array(referenciaSchema).length(2, 'Informe exatamente 2 referências'),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmissao(request, async (req, user) => {
    try {
      const { id } = await params;
      const body = await req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }

      const ag = await loadAgendamento(id);
      if (!ag) return notFoundResponse('Agendamento não encontrado');

      if (ag.processo_status !== 'coletar_referencias') {
        return errorResponse(
          `Processo está em status "${ag.processo_status}" — só pode confirmar referências quando "coletar_referencias"`,
          409,
        );
      }

      const [ref1, ref2] = parsed.data.referencias;

      // 1. Grava referências no banco Recrutamento ────────────────────
      try {
        await queryRecrutamentoWrite(
          `UPDATE public.candidatos
              SET nome_referencia       = $2,
                  telefone_referencia   = $3,
                  descricao_referencia  = $4,
                  status_referencia     = 'coletada',
                  nome_referencia_2     = $5,
                  telefone_referencia_2 = $6,
                  descricao_referencia_2 = $7,
                  status_referencia_2   = 'coletada'
            WHERE id = $1::int`,
          [
            Number(ag.candidato_recrutamento_id),
            ref1.nome,
            ref1.telefone.replace(/\D/g, ''),
            ref1.descricao ?? null,
            ref2.nome,
            ref2.telefone.replace(/\D/g, ''),
            ref2.descricao ?? null,
          ],
        );
      } catch (e) {
        console.error('[dia-teste/referencias] falha ao gravar no Recrutamento:', e);
        return serverErrorResponse(
          'Erro ao gravar referências no banco de Recrutamento — tente novamente',
        );
      }

      // 2. Cria provisório + solicitação ───────────────────────────────
      const ctxRes = await query<{
        empresa_id: number;
        cargo_id: number;
        departamento_id: number;
        jornada_id: number;
      }>(
        `SELECT empresa_id, cargo_id, departamento_id, jornada_id
           FROM people.processo_seletivo
          WHERE id = $1::bigint
          LIMIT 1`,
        [ag.processo_seletivo_id],
      );
      const ctx = ctxRes.rows[0];
      if (!ctx) {
        return serverErrorResponse('Processo seletivo não encontrado');
      }

      let nomeCandidato = `Candidato ${ag.candidato_cpf_norm}`;
      try {
        const nRes = await queryRecrutamento<{ nome: string | null }>(
          `SELECT nome FROM public.candidatos WHERE id = $1 LIMIT 1`,
          [Number(ag.candidato_recrutamento_id)],
        );
        const n = nRes.rows[0]?.nome?.trim();
        if (n) nomeCandidato = n;
      } catch (e) {
        console.warn('[dia-teste/referencias] falha ao buscar nome do candidato:', e);
      }

      const resProv = await criarOuReaproveitarProvisorio(
        {
          nome: nomeCandidato,
          cpf: ag.candidato_cpf_norm,
          empresaId: Number(ctx.empresa_id),
          cargoId: Number(ctx.cargo_id),
          departamentoId: Number(ctx.departamento_id),
          jornadaId: Number(ctx.jornada_id),
          diasTeste: null,
        },
        user.userId,
      );

      if (!resProv.ok) {
        await registrarAuditoria(
          buildAuditParams(req, user, {
            acao: 'editar',
            modulo: 'recrutamento_dia_teste',
            descricao: `Referências gravadas (#${id}) mas pré-admissão NÃO foi criada (${resProv.erro.code}) — intervenção manual necessária`,
            dadosNovos: {
              agendamentoId: id,
              processoId: ag.processo_seletivo_id,
              erroProvisorio: resProv.erro,
            },
          }),
        );
        const erro = resProv.erro;
        let detalhe = 'erro desconhecido';
        switch (erro.code) {
          case 'cpf_invalido':
            detalhe = 'CPF do candidato inválido';
            break;
          case 'colaborador_ativo':
            detalhe = 'já existe colaborador ativo com este CPF';
            break;
          case 'processo_em_andamento':
            detalhe = 'já existe processo de admissão em andamento para este CPF';
            break;
          case 'fk_invalida':
            detalhe = `${erro.campo} (id ${erro.id}) não encontrada`;
            break;
          case 'sem_formulario_ativo':
            detalhe = 'nenhum formulário de admissão ativo configurado';
            break;
        }
        return errorResponse(
          `Referências salvas, mas a pré-admissão não pôde ser criada: ${detalhe}. Contate o administrador.`,
          500,
        );
      }

      // 3. Atualiza processo: linka provisório/solicitação e move pra
      //    pré-admissão.
      await query(
        `UPDATE people.processo_seletivo
            SET usuario_provisorio_id   = $1,
                solicitacao_admissao_id = $2::uuid,
                status                  = 'pre_admissao',
                atualizado_em           = NOW()
          WHERE id = $3::bigint`,
        [
          resProv.data.provRow.id,
          resProv.data.solicitacaoId,
          ag.processo_seletivo_id,
        ],
      );

      await registrarAuditoria(
        buildAuditParams(req, user, {
          acao: 'editar',
          modulo: 'recrutamento_dia_teste',
          descricao: `Referências do candidato confirmadas e processo movido para pré-admissão (#${id}, candidato ${nomeCandidato})`,
          dadosNovos: {
            agendamentoId: id,
            processoId: ag.processo_seletivo_id,
            referencias: [
              { nome: ref1.nome, telefone: ref1.telefone },
              { nome: ref2.nome, telefone: ref2.telefone },
            ],
            provisorio: {
              provisorioId: resProv.data.provRow.id,
              solicitacaoId: resProv.data.solicitacaoId,
              reutilizado: resProv.data.reutilizado,
              readmissao: resProv.data.readmissao,
            },
          },
        }),
      );

      return successResponse({
        agendamentoId: id,
        processo: {
          id: ag.processo_seletivo_id,
          status: 'pre_admissao',
        },
        provisorio: {
          provisorioId: resProv.data.provRow.id,
          solicitacaoId: resProv.data.solicitacaoId,
          reutilizado: resProv.data.reutilizado,
          readmissao: resProv.data.readmissao,
        },
      });
    } catch (error) {
      console.error('[dia-teste/referencias] erro:', error);
      return serverErrorResponse('Erro ao confirmar referências do candidato');
    }
  });
}
