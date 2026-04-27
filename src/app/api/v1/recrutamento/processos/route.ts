import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  createdResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { criarOuReaproveitarProvisorio } from '@/lib/usuarios-provisorios';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { enviarMensagemWhatsApp, enviarMidiaWhatsApp } from '@/lib/evolution-api';

// POST /api/v1/recrutamento/processos
//
// Sprint 1 — caminho B (pré-admissão direta).
//
// Recebe candidato selecionado da aba Candidatos + complementação manual
// (vínculo, opcionalmente endereço/RG/PIX, etc.). Cria o usuário provisório
// (ou reaproveita CPF rejeitado, mesmo trilho do POST /usuarios-provisorios),
// abre o processo_seletivo no banco do People apontando pra linha do
// candidato no banco de Recrutamento, e dispara WhatsApp orientando
// instalação do app + entrar com CPF.
//
// Caminho A (dia de teste) NÃO é tratado aqui — fica para Sprint 2.

const schema = z.object({
  candidatoRecrutamentoId: z.number().int().positive(),
  candidatoCpf: z.string().min(11),
  caminho: z.literal('pre_admissao'), // Sprint 1: somente caminho B

  // dados pessoais usados na criação do provisório
  nome: z.string().min(3).max(255),

  // vínculo no People
  empresaId: z.number().int().positive(),
  cargoId: z.number().int().positive(),
  departamentoId: z.number().int().positive(),
  jornadaId: z.number().int().positive(),
  diasTeste: z.number().int().min(0).max(365).optional().nullable(),

  // dados complementares (persistidos junto à solicitação ou no provisório,
  // não obrigatórios pra fluxo B; o app de admissão coleta o resto).
  telefone: z.string().min(8).max(20).optional().nullable(),

  // mensagem WhatsApp custom — se vier, usa; senão usa template default
  mensagemWhatsApp: z.string().max(2000).optional().nullable(),
});

function conflictWithCode(message: string, code: string) {
  return NextResponse.json({ success: false, error: message, code }, { status: 409 });
}

const MENSAGEM_WHATSAPP_DEFAULT = (nome: string) => {
  const primeiroNome = nome.split(' ')[0];
  return `Olá, ${primeiroNome}, tudo bem? Meu nome é João, faço parte da equipe do Departamento Pessoal da Bluetech Window Films.

Você foi aprovado em nosso processo seletivo! Meus parabéns, estamos muito felizes em ter você com a gente.

Para dar continuidade à sua admissão, é necessário instalar o aplicativo *People* no seu celular. Use o link de acordo com o tipo do seu aparelho:

📱 *iPhone (iOS)* – baixe pela App Store:
https://apps.apple.com/br/app/people-by-valeris/id6761028795

🤖 *Celular Android (Samsung, Motorola, Xiaomi, etc.)* – baixe pela Google Play:
https://play.google.com/store/apps/details?id=com.people.valeris

Após instalar, siga estes passos no primeiro acesso:

1. Abra o app e *permita todas as autorizações solicitadas* (notificações, câmera e localização).
2. Clique em *"Área do colaborador"*.
3. Em seguida, selecione *"Primeiro acesso"*.
4. Preencha com o seu *CPF*.

Depois disso, o próprio aplicativo irá te orientar com as próximas etapas.

Se tiver qualquer dúvida, estou à disposição para te ajudar!`;
};

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const primeira = parsed.error.issues[0];
        const campo = primeira.path.join('.') || 'body';
        return errorResponse(`${campo}: ${primeira.message}`, 400);
      }
      const dados = parsed.data;
      const cpfNorm = dados.candidatoCpf.replace(/\D/g, '');

      // 1) Confere se o candidato existe no banco externo de Recrutamento.
      // Não é estritamente necessário (o front já enviou o id), mas evita
      // criar processo_seletivo "fantasma" se o id veio errado.
      const candResult = await queryRecrutamento<{
        id: number;
        nome: string;
        telefone: string | null;
        vaga: string | null;
      }>(
        `SELECT id, nome, telefone, vaga
           FROM public.candidatos
          WHERE id = $1
            AND regexp_replace(cpf, '\\D', '', 'g') = $2
          LIMIT 1`,
        [dados.candidatoRecrutamentoId, cpfNorm]
      );
      const candidato = candResult.rows[0];
      if (!candidato) {
        return errorResponse(
          'Candidato não encontrado no banco de Recrutamento (id/CPF não batem)',
          404
        );
      }

      // 2) Veta processo já vivo no People.
      const existente = await query<{ id: string; status: string }>(
        `SELECT id::text, status
           FROM people.processo_seletivo
          WHERE candidato_cpf_norm = $1 AND status <> 'cancelado'
          LIMIT 1`,
        [cpfNorm]
      );
      if (existente.rows[0]) {
        return conflictWithCode(
          `Já existe um processo seletivo ativo para este CPF (id ${existente.rows[0].id}, status ${existente.rows[0].status})`,
          'processo_em_andamento'
        );
      }

      // 3) Transação: cria provisório/solicitação + processo_seletivo.
      await query('BEGIN', []);
      let resultadoProv: Awaited<ReturnType<typeof criarOuReaproveitarProvisorio>>;
      let processoId: string;
      try {
        resultadoProv = await criarOuReaproveitarProvisorio(
          {
            nome: dados.nome,
            cpf: cpfNorm,
            empresaId: dados.empresaId,
            cargoId: dados.cargoId,
            departamentoId: dados.departamentoId,
            jornadaId: dados.jornadaId,
            diasTeste: dados.diasTeste ?? null,
          },
          user.userId
        );
        if (!resultadoProv.ok) {
          await query('ROLLBACK', []);
        } else {
          const procIns = await query<{ id: string }>(
            `INSERT INTO people.processo_seletivo
               (candidato_recrutamento_id, candidato_cpf_norm, vaga_snapshot,
                usuario_provisorio_id, solicitacao_admissao_id,
                empresa_id, cargo_id, departamento_id, jornada_id,
                status, caminho, criado_por)
             VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9,
                     'pre_admissao', 'pre_admissao', $10)
             RETURNING id::text`,
            [
              dados.candidatoRecrutamentoId,
              cpfNorm,
              candidato.vaga,
              resultadoProv.data.provRow.id,
              resultadoProv.data.solicitacaoId,
              dados.empresaId,
              dados.cargoId,
              dados.departamentoId,
              dados.jornadaId,
              user.userId,
            ]
          );
          processoId = procIns.rows[0].id;
          await query('COMMIT', []);
        }
      } catch (txErr) {
        await query('ROLLBACK', []);
        throw txErr;
      }

      if (!resultadoProv.ok) {
        const erro = resultadoProv.erro;
        switch (erro.code) {
          case 'cpf_invalido':
            return errorResponse('CPF inválido', 400);
          case 'colaborador_ativo':
            return conflictWithCode('Há um colaborador ativo com este CPF', 'colaborador_ativo');
          case 'processo_em_andamento':
            return conflictWithCode(
              'Há um processo de admissão em andamento para este CPF',
              'processo_em_andamento'
            );
          case 'fk_invalida':
            return errorResponse(`${erro.campo} não encontrada: ${erro.id}`, 400);
          case 'sem_formulario_ativo':
            return serverErrorResponse('Nenhum formulário de admissão ativo');
        }
      }

      const { provRow, solicitacaoId, reutilizado, readmissao } = resultadoProv.data;

      // 4) WhatsApp (best-effort — falha não rola back).
      // Se WHATSAPP_VIDEO_PRE_ADMISSAO_URL estiver configurada, envia vídeo
      // com a mensagem como legenda (1 notificação só); caso contrário,
      // fallback para texto puro.
      const numeroWhats = (dados.telefone ?? candidato.telefone ?? '').replace(/\D/g, '');
      let whatsappOk = false;
      let whatsappErro: string | null = null;
      if (numeroWhats) {
        const texto = dados.mensagemWhatsApp?.trim() || MENSAGEM_WHATSAPP_DEFAULT(provRow.nome);
        const videoUrl = process.env.WHATSAPP_VIDEO_PRE_ADMISSAO_URL?.trim();
        if (videoUrl) {
          const result = await enviarMidiaWhatsApp(numeroWhats, videoUrl, {
            mediatype: 'video',
            caption: texto,
            fileName: 'pre-admissao.mp4',
            mimetype: 'video/mp4',
          });
          // Se o vídeo falhar (ex: arquivo offline, Evolution recusou),
          // ainda tenta o texto puro pra não deixar o candidato sem aviso.
          if (result.ok) {
            whatsappOk = true;
          } else {
            console.warn('[recrutamento/processos] Falha no vídeo, caindo pra texto:', result.erro);
            const fallback = await enviarMensagemWhatsApp(numeroWhats, texto);
            whatsappOk = fallback.ok;
            whatsappErro = fallback.ok
              ? `video_falhou_${result.erro}`
              : fallback.erro ?? null;
          }
        } else {
          const result = await enviarMensagemWhatsApp(numeroWhats, texto);
          whatsappOk = result.ok;
          whatsappErro = result.erro ?? null;
        }
      } else {
        whatsappErro = 'sem_telefone';
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'criar',
        modulo: 'recrutamento_processo_seletivo',
        descricao: `Processo seletivo aberto (caminho B) para ${provRow.nome} (CPF ${cpfNorm}). Provisório ${reutilizado ? 'reaproveitado' : 'novo'}.`,
        colaboradorId: provRow.id,
        colaboradorNome: provRow.nome,
        dadosNovos: {
          processoId: processoId!,
          solicitacaoId,
          candidatoRecrutamentoId: dados.candidatoRecrutamentoId,
          whatsappOk,
          whatsappErro,
          reutilizado,
          readmissao,
        },
      }));

      const payload = {
        processoId: processoId!,
        provisorio: {
          id: provRow.id,
          nome: provRow.nome,
          cpf: provRow.cpf,
          empresaId: provRow.empresa_id,
          cargoId: provRow.cargo_id,
          departamentoId: provRow.departamento_id,
          jornadaId: provRow.jornada_id,
          diasTeste: provRow.dias_teste ?? null,
          status: provRow.status,
          criadoEm: provRow.criado_em,
        },
        solicitacaoId,
        reutilizado,
        readmissao,
        whatsapp: { enviado: whatsappOk, erro: whatsappErro },
      };

      return reutilizado ? successResponse(payload) : createdResponse(payload);
    } catch (error) {
      console.error('[recrutamento/processos POST] erro:', error);
      return serverErrorResponse('Erro ao abrir processo de recrutamento');
    }
  });
}

// GET /api/v1/recrutamento/processos — lista processos ativos no People
export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const status = searchParams.get('status');

      const filtros: string[] = [];
      const params: unknown[] = [];
      if (status) {
        filtros.push(`ps.status = $${params.length + 1}`);
        params.push(status);
      } else {
        filtros.push(`ps.status <> 'cancelado'`);
      }
      const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

      const result = await query(
        `SELECT ps.id::text                 AS id,
                ps.candidato_recrutamento_id AS candidato_recrutamento_id,
                ps.candidato_cpf_norm        AS cpf,
                ps.vaga_snapshot             AS vaga,
                ps.status, ps.caminho,
                ps.criado_em                 AS criado_em,
                ps.solicitacao_admissao_id   AS solicitacao_id,
                up.id                        AS provisorio_id,
                up.nome                      AS provisorio_nome,
                e.nome_fantasia              AS empresa_nome,
                c.nome                       AS cargo_nome,
                d.nome                       AS departamento_nome
           FROM people.processo_seletivo ps
           LEFT JOIN people.usuarios_provisorios up ON up.id = ps.usuario_provisorio_id
           LEFT JOIN people.empresas      e ON e.id = ps.empresa_id
           LEFT JOIN people.cargos        c ON c.id = ps.cargo_id
           LEFT JOIN people.departamentos d ON d.id = ps.departamento_id
           ${where}
          ORDER BY ps.criado_em DESC`,
        params
      );

      return successResponse(
        result.rows.map((r) => ({
          id: r.id,
          candidatoRecrutamentoId: r.candidato_recrutamento_id,
          cpf: r.cpf,
          vaga: r.vaga,
          status: r.status,
          caminho: r.caminho,
          criadoEm: r.criado_em,
          solicitacaoId: r.solicitacao_id,
          provisorio: r.provisorio_id
            ? { id: r.provisorio_id, nome: r.provisorio_nome }
            : null,
          empresa: r.empresa_nome,
          cargo: r.cargo_nome,
          departamento: r.departamento_nome,
        }))
      );
    } catch (error) {
      console.error('[recrutamento/processos GET] erro:', error);
      return serverErrorResponse('Erro ao listar processos');
    }
  });
}
