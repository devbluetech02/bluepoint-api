import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
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
  'admitido', 'rejeitado',
] as const;
type StatusAdmissao = typeof STATUS_VALIDOS[number];

const STATUS_MENSAGEM: Record<StatusAdmissao, string> = {
  aguardando_rh:         'Sua solicitação está sendo analisada pelo RH.',
  correcao_solicitada:   'Alguns itens precisam ser corrigidos. Abra o app para revisar.',
  aso_solicitado:        'Seu exame admissional foi agendado. Verifique os detalhes no app.',
  aso_recebido:          'Seu ASO foi recebido. Em breve você terá uma atualização.',
  em_teste:              'Você está em período de teste. Boa sorte!',
  aso_reprovado:         'O resultado do seu ASO foi considerado inapto. O RH entrará em contato.',
  assinatura_solicitada: 'Seu contrato está pronto para assinatura. Acesse o app para assinar.',
  contrato_assinado:     'Contrato assinado com sucesso! Aguarde os próximos passos.',
  admitido:              'Bem-vindo! Sua admissão foi concluída.',
  rejeitado:             'Sua candidatura não prosseguirá. O RH pode entrar em contato com mais detalhes.',
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

      // ── Migração foto/biometria → colaborador ao admitir ─────────────────
      // Quando o candidato é admitido, tenta vincular foto de perfil e template
      // biométrico ao colaborador recém-criado (identificado pelo CPF do usuário provisório).
      // Executado de forma não-bloqueante: falhas são logadas mas não impedem a resposta.
      if (body.status === 'admitido' && sol.usuario_provisorio_id) {
        migrarDadosBiometricosParaColaborador(id, sol.usuario_provisorio_id, sol.foto_perfil_url).catch(
          (err) => console.error('[admitido] Erro na migração de foto/biometria:', err)
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
      const warnings: string[] = [];

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
      type Link = { url?: string; cpf?: string; signer_cpf?: string; document?: string };
      const payload = (await response.json()) as
        | { links?: Link[]; signing_links?: Link[]; data?: Link[] }
        | Link[];
      const links: Link[] = Array.isArray(payload)
        ? payload
        : payload.links ?? payload.signing_links ?? payload.data ?? [];

      const soDigitos = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
      const cpfAlvo = soDigitos(cpfCandidato);
      const match = cpfAlvo
        ? links.find((l) => soDigitos(l.cpf ?? l.signer_cpf ?? l.document) === cpfAlvo)
        : undefined;
      signingUrl = (match ?? links[0])?.url ?? null;
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
// Migração de foto de perfil e template biométrico para o colaborador admitido
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quando uma solicitação de admissão transita para "admitido", tenta localizar
 * o colaborador recém-criado pelo CPF do usuário provisório e:
 *   1. Copia foto_perfil_url → colaborador.foto_url
 *   2. Move o template de biometria_facial_pendente → biometria_facial
 *
 * É chamada de forma fire-and-forget (não bloqueia a resposta HTTP).
 */
async function migrarDadosBiometricosParaColaborador(
  solicitacaoId: string,
  usuarioProvisorioId: number,
  fotoPerfillUrl: string | null
): Promise<void> {
  // Busca CPF do usuário provisório
  const cpfResult = await query<{ cpf: string | null }>(
    `SELECT cpf FROM people.usuarios_provisorios WHERE id = $1`,
    [usuarioProvisorioId]
  );
  if (cpfResult.rows.length === 0 || !cpfResult.rows[0].cpf) {
    console.warn(`[admitido] Usuário provisório ${usuarioProvisorioId} sem CPF — não é possível localizar colaborador`);
    return;
  }

  const cpf = cpfResult.rows[0].cpf;

  // Localiza colaborador pelo CPF
  const colaboradorResult = await query<{ id: number }>(
    `SELECT id FROM people.colaboradores WHERE cpf = $1 AND status = 'ativo' LIMIT 1`,
    [cpf]
  );
  if (colaboradorResult.rows.length === 0) {
    console.warn(`[admitido] Nenhum colaborador ativo encontrado com CPF do usuário provisório ${usuarioProvisorioId}`);
    return;
  }

  const colaboradorId = colaboradorResult.rows[0].id;
  console.log(`[admitido] Migrando dados da solicitação ${solicitacaoId} para colaborador ${colaboradorId}`);

  // 1. Copia foto de perfil
  if (fotoPerfillUrl) {
    await query(
      `UPDATE people.colaboradores SET foto_url = $1, atualizado_em = NOW() WHERE id = $2`,
      [fotoPerfillUrl, colaboradorId]
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
