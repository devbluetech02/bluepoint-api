import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { registrarOcorrenciaReadmissao } from '@/lib/ocorrencias-externas';
import { mapCamposParaApi } from '@/lib/formulario-admissao';
import { extrairCamposPessoaisParaColaborador } from '@/lib/admissao-dados-extractor';
import { withAdmissao } from '@/lib/middleware';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';
import { enviarPushParaCargoNome } from '@/lib/push-colaborador';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';
import { registrarAuditoria } from '@/lib/audit';
import { cacheDel, CACHE_KEYS } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

const STATUS_VALIDOS = [
  'aguardando_rh', 'correcao_solicitada', 'aso_solicitado', 'aso_recebido',
  'em_teste', 'aso_reprovado', 'assinatura_solicitada', 'contrato_assinado',
  'admitido', 'rejeitado', 'cancelado',
] as const;
type StatusAdmissao = typeof STATUS_VALIDOS[number];

const STATUS_MENSAGEM: Record<StatusAdmissao, string> = {
  aguardando_rh:         'Sua solicitação está sendo analisada pelo DP.',
  correcao_solicitada:   'Alguns itens precisam ser corrigidos. Abra o app para revisar.',
  aso_solicitado:        'Seu exame admissional foi agendado. Verifique os detalhes no app.',
  aso_recebido:          'Seu ASO foi recebido. Em breve você terá uma atualização.',
  em_teste:              'Você está em período de teste. Boa sorte!',
  aso_reprovado:         'O resultado do seu ASO foi considerado inapto. O DP entrará em contato.',
  assinatura_solicitada: 'Seu contrato está pronto para assinatura. Acesse o app para assinar.',
  contrato_assinado:     'Contrato assinado com sucesso! Aguarde os próximos passos.',
  admitido:              'Bem-vindo! Sua admissão foi concluída.',
  rejeitado:             'Sua candidatura não prosseguirá. O DP pode entrar em contato com mais detalhes.',
  cancelado:             'Pré-admissão cancelada.',
};

// Mensagens para o cargo Administrador em cada transição de status.
// Transições de responsabilidade do próprio admin (correcao_solicitada, aso_solicitado)
// não são incluídas pois o admin já sabe que as executou.
const STATUS_ADMIN: Partial<Record<StatusAdmissao, { titulo: string; mensagem: string }>> = {
  aso_recebido:          { titulo: 'ASO recebido',                mensagem: 'Um candidato enviou o resultado do exame admissional.' },
  assinatura_solicitada: { titulo: 'Contrato aguarda assinatura', mensagem: 'O contrato foi disponibilizado para assinatura de um candidato.' },
  contrato_assinado:     { titulo: 'Contrato assinado',           mensagem: 'Um candidato assinou o contrato de admissão.' },
  admitido:              { titulo: 'Candidato admitido',          mensagem: 'Uma admissão foi concluída com sucesso.' },
};

// Dias da semana: 0=dom, 1=seg ... 6=sab
const DIA_HORARIO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'] as const;

function formatarDataBr(iso: string): string {
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function horarioDoDia(horario: Record<string, unknown> | null, dataIso: string): string {
  if (!horario || !dataIso) return 'consulte o horário de atendimento';
  const diaSemana = new Date(`${dataIso.substring(0, 10)}T12:00:00`).getDay();
  const chave = DIA_HORARIO[diaSemana];
  const dia = horario[chave] as { aberto?: boolean; abre?: string; fecha?: string } | undefined;
  if (!dia?.aberto) return 'fechado neste dia';
  return `${dia.abre} às ${dia.fecha}`;
}

/**
 * Converte dataExame (YYYY-MM-DD ou YYYY-MM-DDTHH:mm[:ss]) + horaExame (HH:mm) opcional
 * em um TIMESTAMPTZ interpretado como horário de Brasília (UTC-3).
 */
function buildDataExameTimestamp(
  dataExame: string,
  horaExame?: string | null,
): string {
  if (dataExame.includes('T')) {
    // Já tem componente de hora — acrescenta offset de Brasília se não houver timezone
    const hasTimezone = dataExame.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dataExame);
    return hasTimezone ? dataExame : `${dataExame}-03:00`;
  }
  // Formato YYYY-MM-DD — combina com horaExame ou meia-noite
  const hora = horaExame ? `${horaExame}:00` : '00:00:00';
  return `${dataExame}T${hora}-03:00`;
}

/**
 * PATCH /api/v1/admissao/solicitacoes/:id/status
 *
 * Atualiza o status de uma solicitação de admissão.
 *
 * Body padrão:   { status }
 * Body ASO:      { status: "aso_solicitado", mensagemAso, clinicaId?, dataExame? }
 *
 * Ao mudar para aso_solicitado:
 *  - Persiste clinica_id, data_exame_aso, mensagem_aso, aso_solicitado_em
 *  - Envia push ao candidato com mensagemAso (sem reformatar)
 *  - Se clínica.precisa_confirmacao=false e canal=whatsapp → envia WhatsApp via Evolution API
 *  - Se Evolution falhar → retorna 200 com warnings: ["evolution_falhou"]
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAdmissao(request, async (req) => {
    try {
      const { id } = await params;

      const body = await req.json().catch(() => null);
      if (!body?.status) return errorResponse('"status" é obrigatório', 400);

      if (!STATUS_VALIDOS.includes(body.status)) {
        return errorResponse(`Status inválido. Valores aceitos: ${STATUS_VALIDOS.join(', ')}`, 400);
      }

      // Cancelamento tem auditoria específica (quem, quando, etapa, motivo) e
      // integra com SignProof — usa o endpoint dedicado, não o PATCH genérico.
      if (body.status === 'cancelado') {
        return errorResponse(
          'Use POST /api/v1/admissao/solicitacoes/:id/cancelar para cancelar uma pré-admissão',
          400,
        );
      }

      // ── Validações específicas de aso_solicitado ──────────────────────────
      if (body.status === 'aso_solicitado') {
        if (!body.mensagemAso || typeof body.mensagemAso !== 'string' || !body.mensagemAso.trim()) {
          return errorResponse('"mensagemAso" é obrigatório quando status="aso_solicitado"', 400);
        }
        if (body.clinicaId !== undefined && body.clinicaId !== null) {
          const clinicaExists = await query('SELECT id FROM people.clinicas WHERE id = $1', [body.clinicaId]);
          if (clinicaExists.rows.length === 0) return errorResponse('Clínica não encontrada', 404);
        }
      }

      // ── Validações específicas de assinatura_solicitada ───────────────────
      // Sem documento_assinatura_id, o SignProof status checker nunca verifica a
      // solicitação (filtra WHERE documento_assinatura_id IS NOT NULL) — a linha
      // trava em assinatura_solicitada mesmo após o candidato assinar.
      if (body.status === 'assinatura_solicitada') {
        if (typeof body.documentoAssinaturaId !== 'string' || !body.documentoAssinaturaId.trim()) {
          return errorResponse('"documentoAssinaturaId" é obrigatório quando status="assinatura_solicitada"', 400);
        }
      }

      // ── Busca solicitação ─────────────────────────────────────────────────
      const solResult = await query<{
        id: string; status: string;
        usuario_provisorio_id: number | null;
        onesignal_subscription_id: string | null;
        foto_perfil_url: string | null;
      }>(
        `SELECT id, status, usuario_provisorio_id, onesignal_subscription_id, foto_perfil_url
         FROM people.solicitacoes_admissao WHERE id = $1`,
        [id]
      );
      if (solResult.rows.length === 0) return notFoundResponse('Solicitação não encontrada');
      const sol = solResult.rows[0];

      // ── Pré-check defensivo para admitido ─────────────────────────────────
      // Se já existe colaborador ATIVO com o mesmo CPF, recusamos a transição:
      // quem deveria bloquear isso é POST /usuarios-provisorios, mas protegemos
      // contra contratos corrompidos (ex.: solicitações antigas pré-regra nova).
      if (body.status === 'admitido' && sol.usuario_provisorio_id) {
        const conflict = await query<{ id: number; status: string }>(
          `SELECT c.id, c.status
             FROM people.usuarios_provisorios up
             JOIN people.colaboradores c ON c.cpf = up.cpf
            WHERE up.id = $1
              AND c.status = 'ativo'
            LIMIT 1`,
          [sol.usuario_provisorio_id]
        );
        if (conflict.rows.length > 0) {
          return NextResponse.json(
            { success: false, error: 'Já existe um colaborador ativo com este CPF', code: 'colaborador_ativo' },
            { status: 409 }
          );
        }
      }

      // ── Monta UPDATE ──────────────────────────────────────────────────────
      const sets: string[] = ['status = $1', 'atualizado_em = NOW()'];
      const values: unknown[] = [body.status];

      // Timestamp consolidado (data + hora → TIMESTAMPTZ Brasília)
      const dataExameTs: string | null = body.dataExame
        ? buildDataExameTimestamp(body.dataExame, body.horaExame ?? null)
        : null;

      if (body.status === 'aso_solicitado') {
        values.push(body.clinicaId ?? null);   sets.push(`clinica_id = $${values.length}`);
        values.push(dataExameTs);              sets.push(`data_exame_aso = $${values.length}`);
        values.push(body.mensagemAso.trim());  sets.push(`mensagem_aso = $${values.length}`);
        sets.push('aso_solicitado_em = NOW()');
      }

      // Preserva o status anterior ao entrar em correcao_solicitada — usado
      // no reenvio pós-correção para restaurar o ponto em que o candidato estava.
      // Não sobrescreve se a transição for de correcao_solicitada para ela mesma.
      if (body.status === 'correcao_solicitada' && sol.status !== 'correcao_solicitada') {
        values.push(sol.status);
        sets.push(`status_antes_correcao = $${values.length}`);
      }

      // Motivo opcional quando o status é rejeitado — aceito só nessa transição.
      if (body.status === 'rejeitado' && typeof body.motivo === 'string' && body.motivo.trim()) {
        values.push(body.motivo.trim());
        sets.push(`motivo_rejeicao = $${values.length}`);
      }

      // Campos opcionais — persistidos sempre que informados no body, independentemente do status.
      // Usados principalmente na transição para 'assinatura_solicitada' (vínculo com SignProof + data prevista).
      if (typeof body.documentoAssinaturaId === 'string' && body.documentoAssinaturaId.trim()) {
        values.push(body.documentoAssinaturaId.trim());
        sets.push(`documento_assinatura_id = $${values.length}`);
      }
      if (typeof body.dataAdmissao === 'string' && body.dataAdmissao.trim()) {
        values.push(body.dataAdmissao.trim());
        sets.push(`data_admissao = $${values.length}::date`);
      }

      values.push(id);
      await query(
        `UPDATE people.solicitacoes_admissao SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values
      );

      // ── Pós-admissão: readmissão de ex-colaborador + biometria ────────────
      // Quando transita para 'admitido', detecta se o CPF bate com um colaborador
      // INATIVO — nesse caso reativa, substitui documentos e registra ocorrência
      // "Readmissão". Senão, mantém o comportamento de migrar só biometria/foto
      // (o colaborador é criado pelo RH via POST /criar-colaborador separadamente).
      // Executado de forma não-bloqueante.
      if (body.status === 'admitido' && sol.usuario_provisorio_id) {
        const colaboradorIdExplicito = typeof body.colaboradorId === 'string' ? parseInt(body.colaboradorId, 10) : (typeof body.colaboradorId === 'number' ? body.colaboradorId : null);
        processarTransicaoAdmitido(id, sol.usuario_provisorio_id, sol.foto_perfil_url, colaboradorIdExplicito).catch(
          (err) => console.error('[admitido] Erro no processamento pós-admissão:', err)
        );
      }

      // ── Push enriquecido com link de assinatura (SignProof) ──────────────
      // Substitui a notificação genérica de assinatura_solicitada por uma com deep-link
      // direto para o contrato no SignProof. Fire-and-forget — falha no SignProof ou no
      // envio do push não reverte o status (contrato já foi enviado por e-mail pelo SignProof).
      if (body.status === 'assinatura_solicitada' && sol.usuario_provisorio_id) {
        notificarAssinaturaContrato(
          id,
          sol.usuario_provisorio_id,
          body.documentoAssinaturaId.trim(),
          sol.onesignal_subscription_id,
        ).catch((err) => console.error('[assinatura_solicitada] Falha ao notificar candidato:', err));
      }

      // Warnings agregados (ex.: WhatsApp do candidato/clínica falhou) —
      // declarado aqui pra ficar acessível tanto no bloco de push do candidato
      // (que dispara WhatsApp pro próprio candidato) quanto no bloco de
      // WhatsApp pra clínica mais abaixo.
      const warnings: string[] = [];

      // ── Push para o candidato ─────────────────────────────────────────────
      // assinatura_solicitada é tratada acima com link de assinatura dedicado.
      if (sol.usuario_provisorio_id && body.status !== 'assinatura_solicitada') {
        const pushData: Record<string, unknown> = { solicitacaoId: id };
        let pushMensagem: string;

        if (body.status === 'aso_solicitado' && body.clinicaId) {
          const clinicaPushResult = await query<{
            nome: string;
            logradouro: string | null; numero: string | null;
            bairro: string | null; cidade: string | null;
            estado: string | null; cep: string | null;
          }>(
            `SELECT nome, logradouro, numero, bairro, cidade, estado, cep
             FROM people.clinicas WHERE id = $1`,
            [body.clinicaId]
          );
          const cp = clinicaPushResult.rows[0];
          if (cp) {
            pushData.clinica = cp.nome;
            const parts: string[] = [];
            if (cp.logradouro) parts.push(cp.logradouro);
            if (cp.numero)     parts.push(`, ${cp.numero}`);
            if (cp.bairro)     parts.push(` — ${cp.bairro}`);
            if (cp.cidade && cp.estado) parts.push(`, ${cp.cidade}/${cp.estado}`);
            else if (cp.cidade) parts.push(`, ${cp.cidade}`);
            if (cp.cep)        parts.push(`, ${cp.cep}`);
            pushData.endereco = parts.join('');
          }
          if (dataExameTs) {
            pushData.dataHora = dataExameTs;
          }
          if (body.mensagemAso?.trim()) pushData.observacoes = body.mensagemAso.trim();

          // Corpo da notificação: linha 1 = clínica, linha 2 = data/hora, linha 3+ = observação
          const linhas: string[] = [];
          if (pushData.clinica) linhas.push(`Clínica: ${pushData.clinica}`);
          if (dataExameTs) {
            const [y, m, d] = dataExameTs.substring(0, 10).split('-');
            linhas.push(`Data: ${d}/${m}/${y}`);
            const hora = dataExameTs.substring(11, 16);
            if (hora && hora !== '00:00') linhas.push(`Hora: ${hora}`);
          }
          if (body.mensagemAso?.trim()) linhas.push(body.mensagemAso.trim());
          pushMensagem = linhas.join('\n');
        } else {
          pushMensagem = body.status === 'aso_solicitado'
            ? body.mensagemAso.trim()
            : STATUS_MENSAGEM[body.status as StatusAdmissao];
        }

        enviarPushParaProvisorio(
          sol.usuario_provisorio_id,
          {
            titulo:     body.status === 'aso_solicitado' ? 'Exame admissional agendado' : 'Atualização na sua pré-admissão',
            mensagem:   pushMensagem,
            severidade: body.status === 'admitido' ? 'info' : 'atencao',
            data:       pushData,
            url:        body.status === 'aso_solicitado' ? '/aso-info' : '/pre-admissao',
          },
          sol.onesignal_subscription_id,
        ).catch(console.error);

        // ── WhatsApp para o candidato (só em aso_solicitado) ────────────────
        // Reforça a notificação push no canal mais visível e à prova de app
        // desinstalado/sem permissão de push. Mesmas infos do push (clínica,
        // endereço, data, hora, observações) — sem deep-link porque o app
        // ainda não tem Universal/App Links configurados, então o candidato
        // navega pelo app manualmente.
        if (body.status === 'aso_solicitado') {
          const candWpp = await query<{ telefone: string | null; nome: string }>(
            `SELECT telefone, nome FROM people.usuarios_provisorios WHERE id = $1`,
            [sol.usuario_provisorio_id],
          );
          const c = candWpp.rows[0];
          const telCand = (c?.telefone ?? '').replace(/\D/g, '');
          if (telCand.length >= 10) {
            const primeiroNome = (c?.nome ?? 'Candidato').split(' ')[0];
            const linhasCand: string[] = [
              `🏥 *Exame admissional agendado*`,
              ``,
              `Olá, ${primeiroNome}!`,
              `Seu exame admissional foi agendado. Confira os detalhes abaixo:`,
            ];
            if (pushData.clinica) {
              linhasCand.push(``, `🩺 *Clínica:* ${pushData.clinica}`);
            }
            if (pushData.endereco) {
              linhasCand.push(`📍 *Endereço:* ${pushData.endereco}`);
            }
            if (dataExameTs) {
              const [y, m, d] = dataExameTs.substring(0, 10).split('-');
              linhasCand.push(`📅 *Data:* ${d}/${m}/${y}`);
              const hora = dataExameTs.substring(11, 16);
              if (hora && hora !== '00:00') {
                linhasCand.push(`⏰ *Hora:* ${hora}`);
              }
            }
            if (body.mensagemAso?.trim()) {
              linhasCand.push(``, `📌 *Observações do DP:*`, body.mensagemAso.trim());
            }
            linhasCand.push(
              ``,
              `Acompanhe os detalhes da sua admissão no app *People*.`,
            );

            const r = await enviarMensagemWhatsApp(telCand, linhasCand.join('\n'));
            if (!r.ok) {
              warnings.push('whatsapp_candidato_falhou');
              console.warn(`[ASO] WhatsApp candidato falhou: ${r.erro}`);
            }
          } else {
            warnings.push('whatsapp_candidato_sem_telefone');
          }
        }
      }

      // ── Push para cargo Administrador ─────────────────────────────────────
      const adminPush = STATUS_ADMIN[body.status as StatusAdmissao];
      if (adminPush) {
        enviarPushParaCargoNome('Administrador', {
          titulo:     adminPush.titulo,
          mensagem:   adminPush.mensagem,
          severidade: body.status === 'admitido' ? 'info' : 'atencao',
          data:       { tipo: 'admissao_status', solicitacaoId: id, status: body.status },
          url:        '/pre-admissao',
        }).catch(console.error);
      }

      // ── WhatsApp para a clínica ────────────────────────────────────────────
      // Dispara sempre que a clínica tiver whatsapp_numero,
      // EXCETO quando canal_agendamento = 'site' (DP já agendou pelo site).
      // (warnings já foi declarado mais acima, junto do bloco de push.)

      if (body.status === 'aso_solicitado' && body.clinicaId) {
        const clinicaResult = await query<{
          nome: string;
          canal_agendamento: string | null;
          whatsapp_numero: string | null;
          horario_atendimento: Record<string, unknown> | null;
          observacoes_agendamento: string | null;
          empresa_id: number | null;
        }>(
          `SELECT nome, canal_agendamento, whatsapp_numero,
                  horario_atendimento, observacoes_agendamento, empresa_id
           FROM people.clinicas WHERE id = $1`,
          [body.clinicaId]
        );

        const clinica = clinicaResult.rows[0];

        if (clinica && clinica.whatsapp_numero && clinica.canal_agendamento !== 'site') {
          // Busca dados do candidato (nome, CPF, cargo)
          let nomeCandidato = 'Candidato';
          let cpfCandidato: string | null = null;
          let nomeCargo: string | null = null;

          if (sol.usuario_provisorio_id) {
            const candidatoResult = await query<{
              nome: string;
              cpf: string | null;
              cargo_nome: string | null;
            }>(
              `SELECT up.nome, up.cpf, cg.nome AS cargo_nome
               FROM people.usuarios_provisorios up
               LEFT JOIN people.cargos cg ON cg.id = up.cargo_id
               WHERE up.id = $1`,
              [sol.usuario_provisorio_id]
            );
            if (candidatoResult.rows.length > 0) {
              const c = candidatoResult.rows[0];
              nomeCandidato = c.nome;
              cpfCandidato  = c.cpf ?? null;
              nomeCargo     = c.cargo_nome ?? null;
            }
          }

          // Busca dados da empresa da clínica
          let razaoSocial: string | null = null;
          let nomeFantasia: string | null = null;
          let cnpj: string | null = null;

          if (clinica.empresa_id) {
            const empresaResult = await query<{
              razao_social: string | null;
              nome_fantasia: string | null;
              cnpj: string | null;
            }>(
              `SELECT razao_social, nome_fantasia, cnpj FROM people.empresas WHERE id = $1`,
              [clinica.empresa_id]
            );
            if (empresaResult.rows.length > 0) {
              razaoSocial  = empresaResult.rows[0].razao_social;
              nomeFantasia = empresaResult.rows[0].nome_fantasia;
              cnpj         = empresaResult.rows[0].cnpj;
            }
          }

          const dataFormatada = dataExameTs ? formatarDataBr(dataExameTs) : 'a definir';
          const horaAgendada = dataExameTs ? dataExameTs.substring(11, 16) : null;
          const horario = horarioDoDia(clinica.horario_atendimento, dataExameTs ?? '');

          const linhas: string[] = [
            `🏥 *Solicitação de Exame Admissional*`,
            ``,
            `Olá! Segue solicitação de exame para um candidato.`,
            ``,
            `👤 *Candidato*`,
            `• Nome: ${nomeCandidato}`,
          ];
          if (cpfCandidato) linhas.push(`• CPF: ${cpfCandidato}`);
          if (nomeCargo)    linhas.push(`• Cargo: ${nomeCargo}`);

          if (razaoSocial || nomeFantasia || cnpj) {
            linhas.push(``, `🏢 *Empresa*`);
            if (razaoSocial)  linhas.push(`• Razão social: ${razaoSocial}`);
            if (nomeFantasia) linhas.push(`• Nome fantasia: ${nomeFantasia}`);
            if (cnpj)         linhas.push(`• CNPJ: ${cnpj}`);
          }

          linhas.push(``, `📅 *Data do exame:* ${dataFormatada}`);
          if (horaAgendada && horaAgendada !== '00:00') {
            linhas.push(`⏰ *Hora do exame:* ${horaAgendada}`);
          } else {
            linhas.push(`⏰ *Horário de atendimento:* ${horario}`);
          }

          if (clinica.canal_agendamento !== 'whatsapp') {
            linhas.push(``, `ℹ️ _Este agendamento é por ordem de chegada._`);
          }

          if (clinica.observacoes_agendamento) {
            linhas.push(``, `📌 *Observações:* ${clinica.observacoes_agendamento}`);
          }

          const mensagemWpp = linhas.join('\n');

          const evolResult = await enviarMensagemWhatsApp(clinica.whatsapp_numero, mensagemWpp);
          if (!evolResult.ok) {
            warnings.push('evolution_falhou');
            console.warn(`[ASO] Evolution falhou para clínica ${body.clinicaId}: ${evolResult.erro}`);
          }

          await registrarAuditoria({
            acao: 'criar',
            modulo: 'admissao',
            descricao: `ASO solicitado — clínica ${clinica.nome}, candidato ${nomeCandidato}, Evolution: ${evolResult.ok ? 'ok' : 'falhou'}`,
            dadosNovos: {
              solicitacaoId: id,
              clinicaId: body.clinicaId,
              dataExame: dataExameTs,
              canal: clinica.canal_agendamento,
              evolutionEnviado: evolResult.ok,
            },
          });
        }
      }

      const response: Record<string, unknown> = {
        id,
        status: body.status,
        atualizadoEm: new Date().toISOString(),
      };
      if (warnings.length > 0) response.warnings = warnings;

      return successResponse(response);
    } catch (error) {
      console.error('Erro ao atualizar status da solicitação:', error);
      return serverErrorResponse('Erro ao atualizar status');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Push de "contrato aguardando assinatura" com deep-link do SignProof
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca o link de assinatura do candidato no SignProof e dispara push.
 * Fire-and-forget: qualquer falha é apenas logada.
 *
 * Tenta casar o signatário pelo CPF do candidato; se não achar, usa o primeiro.
 */
async function notificarAssinaturaContrato(
  solicitacaoId: string,
  usuarioProvisorioId: number,
  documentoAssinaturaId: string,
  subscriptionId: string | null,
): Promise<void> {
  const baseUrl = process.env.SIGNPROOF_API_URL;
  const apiKey = process.env.SIGNPROOF_API_KEY;

  if (!baseUrl || !apiKey) {
    console.warn('[assinatura_solicitada] SIGNPROOF_API_URL ou SIGNPROOF_API_KEY ausente — pulando push');
    return;
  }

  // Candidato (nome p/ corpo do push, CPF p/ casar signatário)
  const candidatoResult = await query<{ nome: string; cpf: string | null }>(
    `SELECT nome, cpf FROM people.usuarios_provisorios WHERE id = $1`,
    [usuarioProvisorioId],
  );
  if (candidatoResult.rows.length === 0) {
    console.warn(`[assinatura_solicitada] Usuário provisório ${usuarioProvisorioId} não encontrado`);
    return;
  }
  const { nome: nomeCandidato, cpf: cpfCandidato } = candidatoResult.rows[0];

  // Consulta signing-links
  let signingUrl: string | null = null;
  try {
    const response = await fetch(
      `${baseUrl}/api/v1/integration/documents/${documentoAssinaturaId}/signing-links`,
      { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } },
    );
    if (!response.ok) {
      console.error(
        `[assinatura_solicitada] signing-links HTTP ${response.status}: ${await response.text().catch(() => '')}`,
      );
    } else {
      // Conforme INTEGRATION_API.md §10, o campo é `signing_link` (não `url`).
      // Mantemos fallback pra `url` por garantia caso o backend mude o nome.
      type Link = {
        signing_link?: string;
        url?: string;
        cpf?: string;
        signer_cpf?: string;
        document?: string;
      };
      const payload = (await response.json()) as
        | { links?: Link[]; signing_links?: Link[]; data?: Link[] }
        | Link[];
      const links: Link[] = Array.isArray(payload)
        ? payload
        : payload.signing_links ?? payload.links ?? payload.data ?? [];

      const soDigitos = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
      const cpfAlvo = soDigitos(cpfCandidato);
      const match = cpfAlvo
        ? links.find((l) => soDigitos(l.cpf ?? l.signer_cpf ?? l.document) === cpfAlvo)
        : undefined;
      const chosen = match ?? links[0];
      signingUrl = chosen?.signing_link ?? chosen?.url ?? null;
      if (!signingUrl) {
        console.warn('[assinatura_solicitada] Nenhum signing_link encontrado para doc', documentoAssinaturaId);
      }
    }
  } catch (err) {
    console.error('[assinatura_solicitada] Erro consultando signing-links:', err);
  }

  await enviarPushParaProvisorio(
    usuarioProvisorioId,
    {
      titulo: 'Contrato aguardando assinatura',
      mensagem: `Olá ${nomeCandidato}, seu contrato de admissão está pronto. Toque para assinar.`,
      severidade: 'atencao',
      data: { solicitacaoId, documentoAssinaturaId, signingUrl },
      url: signingUrl ?? '/pre-admissao',
    },
    subscriptionId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pós-admissão: readmissão de ex-colaborador + migração biométrica
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chamada fire-and-forget quando a solicitação transita para 'admitido'.
 * Roteia entre:
 *   - inativo → readmissão (reativa, sobrescreve dados, substitui documentos,
 *     registra ocorrência "Readmissão", migra biometria)
 *   - ativo   → no-op (pré-check no handler já bloqueia; aqui é defensivo)
 *   - none    → só migra biometria se colaborador já tiver sido criado via
 *     POST /criar-colaborador (comportamento legado)
 */
async function processarTransicaoAdmitido(
  solicitacaoId: string,
  usuarioProvisorioId: number,
  fotoPerfilUrl: string | null,
  colaboradorIdExplicito: number | null = null
): Promise<void> {
  const provResult = await query<{
    cpf: string | null;
    nome: string | null;
    empresa_id: number | null;
    cargo_id: number | null;
    departamento_id: number | null;
    jornada_id: number | null;
  }>(
    `SELECT cpf, nome, empresa_id, cargo_id, departamento_id, jornada_id
       FROM people.usuarios_provisorios WHERE id = $1`,
    [usuarioProvisorioId]
  );
  if (provResult.rows.length === 0 || !provResult.rows[0].cpf) {
    console.warn(`[admitido] Provisório ${usuarioProvisorioId} sem CPF — pulando pós-processamento`);
    return;
  }
  const prov = provResult.rows[0];
  const cpf = prov.cpf!;

  const colabResult = await query<{ id: number; status: string; data_desligamento: string | null }>(
    `SELECT id, status, data_desligamento
       FROM people.colaboradores
      WHERE cpf = $1
      ORDER BY (status = 'ativo') DESC, id DESC
      LIMIT 1`,
    [cpf]
  );
  const colab = colabResult.rows[0] ?? null;

  if (colab?.status === 'ativo') {
    // Pré-check no handler deveria ter interceptado; aqui é só log defensivo.
    console.warn(`[admitido] Colaborador ativo encontrado pós-UPDATE (contrato violado) — solicitação ${solicitacaoId}`);
    return;
  }

  if (colab?.status === 'inativo') {
    await reativarColaboradorInativo(colab.id, prov, solicitacaoId, colab.data_desligamento);
    await substituirDocumentosNaReadmissao(colab.id, solicitacaoId);
    registrarOcorrenciaReadmissao({
      nomeColaborador: prov.nome ?? '',
      cpf,
      dataReadmissao: new Date().toISOString().slice(0, 10),
      dataDesligamentoAnterior: colab.data_desligamento,
    }).catch((err) => console.error('[admitido] Falha ao registrar ocorrência Readmissão:', err));
    await migrarBiometriaParaColaborador(solicitacaoId, colab.id, fotoPerfilUrl);
    return;
  }

  // Nenhum colaborador inativo com esse CPF. Tenta:
  // 1) colaboradorId explícito passado pelo frontend (criar-colaborador acabou de rodar)
  // 2) busca por CPF ativo (comportamento legado)
  let targetColabId: number | null = colaboradorIdExplicito;
  if (!targetColabId) {
    const ativoResult = await query<{ id: number }>(
      `SELECT id FROM people.colaboradores WHERE cpf = $1 AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    targetColabId = ativoResult.rows[0]?.id ?? null;
  }
  if (!targetColabId) {
    console.warn(`[admitido] Nenhum colaborador encontrado para CPF ${cpf} — biometria não migrada`);
    return;
  }
  await migrarBiometriaParaColaborador(solicitacaoId, targetColabId, fotoPerfilUrl);
}

/**
 * Reativa um colaborador inativo copiando os vínculos do provisório e
 * sobrescrevendo campos pessoais extraídos do JSONB `dados` da solicitação
 * via heurística de label (ver src/lib/admissao-dados-extractor.ts).
 *
 * Campos com valor extraído não-vazio entram no UPDATE. Os demais são
 * preservados — não sobrescreve com NULL.
 */
async function reativarColaboradorInativo(
  colaboradorId: number,
  prov: {
    nome: string | null;
    empresa_id: number | null;
    cargo_id: number | null;
    departamento_id: number | null;
    jornada_id: number | null;
  },
  solicitacaoId: string,
  dataDesligamentoAnterior: string | null
): Promise<void> {
  // Busca dados do formulário + campos ativos pra aplicar extractor.
  const formRes = await query<{ dados: Record<string, unknown> | null; campos: unknown }>(
    `SELECT s.dados, f.campos
       FROM people.solicitacoes_admissao s
       JOIN people.formularios_admissao f ON f.id = s.formulario_id
      WHERE s.id = $1`,
    [solicitacaoId]
  );
  const dados = formRes.rows[0]?.dados ?? {};
  const campos = mapCamposParaApi(formRes.rows[0]?.campos, true);
  const extraidos = await extrairCamposPessoaisParaColaborador(campos, dados);

  // Monta UPDATE dinâmico: vínculos + campos fixos sempre; campos pessoais só
  // se foram extraídos (não sobrescreve com NULL).
  const sets: string[] = [
    `status            = 'ativo'`,
    `data_desligamento = NULL`,
    `data_admissao     = CURRENT_DATE`,
    `atualizado_em     = NOW()`,
  ];
  const values: unknown[] = [];
  const push = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };

  // Sempre sobrescrever do provisório (mesmo que NULL, pra ser consistente).
  push('nome',            prov.nome);
  push('empresa_id',      prov.empresa_id);
  push('cargo_id',        prov.cargo_id);
  push('departamento_id', prov.departamento_id);
  push('jornada_id',      prov.jornada_id);

  // Campos pessoais extraídos — só entram se presentes.
  const sobrescritosPessoais: string[] = [];
  const preservados: string[] = [];
  const mapa: [keyof typeof extraidos, string][] = [
    ['email',                'email'],
    ['telefone',             'telefone'],
    ['rg',                   'rg'],
    ['data_nascimento',      'data_nascimento'],
    ['endereco_cep',         'endereco.cep'],
    ['endereco_logradouro',  'endereco.logradouro'],
    ['endereco_numero',      'endereco.numero'],
    ['endereco_complemento', 'endereco.complemento'],
    ['endereco_bairro',      'endereco.bairro'],
    ['endereco_cidade',      'endereco.cidade'],
    ['endereco_estado',      'endereco.estado'],
    ['vale_transporte',      'vale_transporte'],
    ['vale_alimentacao',     'vale_alimentacao'],
  ];
  for (const [chave, label] of mapa) {
    const v = extraidos[chave];
    if (v !== undefined) {
      push(chave as string, v);
      sobrescritosPessoais.push(label);
    } else {
      preservados.push(label);
    }
  }

  values.push(colaboradorId);
  await query(
    `UPDATE people.colaboradores SET ${sets.join(', ')} WHERE id = $${values.length}`,
    values
  );

  console.warn(
    `[readmissao:${colaboradorId}] Readmitido (desligamento anterior: ${dataDesligamentoAnterior ?? 'N/A'}) ` +
    `— solicitação ${solicitacaoId}`
  );
  console.warn(
    `[readmissao:${colaboradorId}] Sobrescritos: nome, vínculos (empresa/cargo/departamento/jornada), ` +
    `status, data_desligamento, data_admissao` +
    (sobrescritosPessoais.length ? `, ${sobrescritosPessoais.join(', ')}` : '')
  );
  console.warn(
    `[readmissao:${colaboradorId}] Preservados: ` +
    (preservados.length ? preservados.join(', ') : '(nenhum)')
  );
}

/**
 * Para cada documento enviado na solicitação, substitui o documento
 * correspondente do colaborador (mesmo tipo_documento_id). Documentos de tipos
 * que o colaborador tinha mas não foram reenviados são preservados.
 */
async function substituirDocumentosNaReadmissao(
  colaboradorId: number,
  solicitacaoId: string
): Promise<void> {
  const novos = await query<{
    tipo_documento_id: number;
    codigo: string | null;
    nome: string;
    url: string;
    storage_key: string | null;
    tamanho: number | null;
  }>(
    `SELECT da.tipo_documento_id, t.codigo, da.nome, da.url, da.storage_key, da.tamanho
       FROM people.documentos_admissao da
       LEFT JOIN people.tipos_documento_colaborador t ON t.id = da.tipo_documento_id
      WHERE da.solicitacao_id = $1`,
    [solicitacaoId]
  );

  if (novos.rows.length === 0) return;

  const tipoIds = novos.rows.map((n) => n.tipo_documento_id);
  // Remove documentos existentes dos tipos reenviados (documentos de outros tipos ficam).
  await query(
    `DELETE FROM people.documentos_colaborador
      WHERE colaborador_id = $1
        AND tipo_documento_id = ANY($2::int[])`,
    [colaboradorId, tipoIds]
  );

  for (const d of novos.rows) {
    await query(
      `INSERT INTO people.documentos_colaborador
         (colaborador_id, tipo, tipo_documento_id, nome, url, storage_key, tamanho)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [colaboradorId, d.codigo ?? 'admissao', d.tipo_documento_id, d.nome, d.url, d.storage_key, d.tamanho]
    );
  }

  console.warn(
    `[admitido] ${novos.rows.length} documento(s) substituído(s) no colaborador ${colaboradorId} (tipos: ${tipoIds.join(',')})`
  );
}

async function migrarBiometriaParaColaborador(
  solicitacaoId: string,
  colaboradorId: number,
  fotoPerfilUrl: string | null
): Promise<void> {
  console.log(`[admitido] Migrando biometria da solicitação ${solicitacaoId} para colaborador ${colaboradorId}`);

  // 1. Copia foto de perfil
  if (fotoPerfilUrl) {
    await query(
      `UPDATE people.colaboradores SET foto_url = $1, atualizado_em = NOW() WHERE id = $2`,
      [fotoPerfilUrl, colaboradorId]
    );
    console.log(`[admitido] Foto de perfil copiada para colaborador ${colaboradorId}`);
  }

  // 2. Migra template biométrico (principal + extras se houver)
  const bioResult = await query<{
    template: Buffer;
    foto_referencia_url: string;
    qualidade: number | null;
    templates_extras: Buffer[] | null;
    qualidades_extras: number[] | null;
  }>(
    `SELECT template, foto_referencia_url, qualidade, templates_extras, qualidades_extras
     FROM people.biometria_facial_pendente
     WHERE solicitacao_id = $1`,
    [solicitacaoId]
  );

  if (bioResult.rows.length === 0) {
    console.log(`[admitido] Nenhum template biométrico aguardando migração para a solicitação ${solicitacaoId}`);
    return;
  }

  const bio = bioResult.rows[0];
  const extras = bio.templates_extras ?? [];
  const qualidadesExtras = bio.qualidades_extras ?? [];
  const totalEncodings = 1 + extras.length;

  // Upsert em biometria_facial (atualiza se colaborador já tem registro)
  const existente = await query<{ id: number }>(
    `SELECT id FROM people.biometria_facial WHERE colaborador_id = $1`,
    [colaboradorId]
  );

  if (existente.rows.length > 0) {
    await query(
      `UPDATE people.biometria_facial
          SET encoding            = $1,
              qualidade           = $2,
              foto_referencia_url = $3,
              encodings_extras    = $4,
              qualidades_extras   = $5,
              total_encodings     = $6,
              atualizado_em       = NOW()
        WHERE colaborador_id = $7`,
      [bio.template, bio.qualidade, bio.foto_referencia_url, extras, qualidadesExtras, totalEncodings, colaboradorId]
    );
  } else {
    await query(
      `INSERT INTO people.biometria_facial
         (colaborador_id, encoding, qualidade, foto_referencia_url,
          encodings_extras, qualidades_extras, total_encodings)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [colaboradorId, bio.template, bio.qualidade, bio.foto_referencia_url,
       extras, qualidadesExtras, totalEncodings]
    );
  }

  console.log(`[admitido] Template migrado com ${totalEncodings} amostras (principal + ${extras.length} extras)`);

  // Marca colaborador com face registrada
  await query(
    `UPDATE people.colaboradores SET face_registrada = true, atualizado_em = NOW() WHERE id = $1`,
    [colaboradorId]
  );

  // Remove o registro em biometria_facial_pendente (já migrado acima)
  await query(
    `DELETE FROM people.biometria_facial_pendente WHERE solicitacao_id = $1`,
    [solicitacaoId]
  );

  // Invalida cache de encodings para que a nova face seja considerada nas verificações
  await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

  console.log(`[admitido] Template biométrico migrado para colaborador ${colaboradorId}`);
}
