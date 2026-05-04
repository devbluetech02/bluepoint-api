import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { registrarOcorrenciaReadmissao } from '@/lib/ocorrencias-externas';
import { mapCamposParaApi } from '@/lib/formulario-admissao';
import { extrairCamposPessoaisParaColaborador, type CamposExtraidos } from '@/lib/admissao-dados-extractor';
import { classificarTipoDocumento } from '@/lib/admissao-classificar-doc';
import { withAdmissao } from '@/lib/middleware';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';
import { enviarPushParaCargoNome } from '@/lib/push-colaborador';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';
import { registrarAuditoria } from '@/lib/audit';
import { cacheDel, CACHE_KEYS, invalidateColaboradorCache } from '@/lib/cache';
import { hashPassword } from '@/lib/auth';
import { detectarTipoPorCargo } from '@/lib/cargo-tipo';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

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

      // ── Documentos múltiplos (multi-doc support) ──────────────────────────
      // Front pode enviar `documentos: [{signproofDocId, templateId, titulo,
      // ordem, externalRef}]` — registra cada um em
      // solicitacoes_admissao_documentos. Quando vazio + status =
      // 'assinatura_solicitada', cai no caminho legado (1 doc apenas via
      // documento_assinatura_id) pra back-compat.
      const docsArray = Array.isArray(body.documentos) ? body.documentos : null;
      if (docsArray && docsArray.length > 0) {
        for (const rawDoc of docsArray) {
          if (!rawDoc || typeof rawDoc !== 'object') continue;
          const doc = rawDoc as Record<string, unknown>;
          const docId = typeof doc.signproofDocId === 'string' ? doc.signproofDocId.trim() : '';
          if (!docId) continue;
          const templateId  = typeof doc.templateId  === 'string' ? doc.templateId.trim()  : null;
          const titulo      = typeof doc.titulo      === 'string' ? doc.titulo.trim()      : null;
          const externalRef = typeof doc.externalRef === 'string' ? doc.externalRef.trim() : null;
          const ordem       = typeof doc.ordem       === 'number' ? doc.ordem              : 0;
          await query(
            `INSERT INTO people.solicitacoes_admissao_documentos
               (solicitacao_id, signproof_doc_id, template_id, titulo, ordem, external_ref, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'enviado')
             ON CONFLICT (signproof_doc_id) DO UPDATE
             SET solicitacao_id = EXCLUDED.solicitacao_id,
                 template_id    = EXCLUDED.template_id,
                 titulo         = EXCLUDED.titulo,
                 ordem          = EXCLUDED.ordem,
                 external_ref   = EXCLUDED.external_ref,
                 atualizado_em  = NOW()`,
            [id, docId, templateId, titulo, ordem, externalRef],
          );
        }
      } else if (
        body.status === 'assinatura_solicitada' &&
        typeof body.documentoAssinaturaId === 'string' &&
        body.documentoAssinaturaId.trim()
      ) {
        await query(
          `INSERT INTO people.solicitacoes_admissao_documentos
             (solicitacao_id, signproof_doc_id, ordem, status)
           VALUES ($1, $2, 0, 'enviado')
           ON CONFLICT (signproof_doc_id) DO NOTHING`,
          [id, body.documentoAssinaturaId.trim()],
        );
      }

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
          // Telefone do candidato vem do form de admissao (dados_extraidos
          // JSONB em solicitacoes_admissao) — usuarios_provisorios nao tem
          // coluna telefone. Nome vem de usuarios_provisorios.
          const candWpp = await query<{ telefone: string | null; nome: string }>(
            `SELECT (s.dados_extraidos->>'telefone') AS telefone,
                    up.nome AS nome
               FROM people.solicitacoes_admissao s
               JOIN people.usuarios_provisorios up
                 ON up.id = s.usuario_provisorio_id
              WHERE s.id = $1`,
            [id],
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
 *   - ativo   → no-op (pré-check no handler já bloqueia; aqui é defensivo)
 *   - inativo → readmissão (reativa, sobrescreve dados, substitui documentos,
 *               registra ocorrência "Readmissão", migra biometria)
 *   - none    → cria colaborador novo a partir dos dados da pré-admissão
 *               (extrai do JSONB `dados` via heurística de label) e migra
 *               biometria. Se `colaboradorIdExplicito` for passado, usa ele
 *               em vez de criar (compat com fluxo antigo /criar-colaborador).
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

  // Nenhum colaborador encontrado para esse CPF.
  //
  // Caminho legado: o frontend pré-criava o colaborador via POST /criar-colaborador
  // e mandava o id explícito aqui — só migrava biometria. Mantido por compat.
  //
  // Caminho novo (default): cria o colaborador automaticamente a partir dos dados
  // coletados na pré-admissão, persistindo TODOS os campos do formulário.
  let targetColabId: number | null = colaboradorIdExplicito;
  if (!targetColabId) {
    const ativoResult = await query<{ id: number }>(
      `SELECT id FROM people.colaboradores WHERE cpf = $1 AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    targetColabId = ativoResult.rows[0]?.id ?? null;
  }
  if (!targetColabId) {
    targetColabId = await criarColaboradorAPartirDeAdmissao(prov, cpf, solicitacaoId);
    if (!targetColabId) {
      console.warn(`[admitido] Falha ao criar colaborador para CPF ${cpf} — solicitação ${solicitacaoId}`);
      return;
    }
  }
  await migrarBiometriaParaColaborador(solicitacaoId, targetColabId, fotoPerfilUrl);
}

/**
 * Cria um novo colaborador a partir dos dados da pré-admissão. Usa:
 *   - usuarios_provisorios para nome, cpf, empresa_id, cargo_id,
 *     departamento_id, jornada_id;
 *   - solicitacoes_admissao.dados (JSONB) + extractor de labels para todos
 *     os demais campos (email, telefone, RG, endereço, dados bancários,
 *     contato de emergência, biometria física, vales, senha definida pelo
 *     candidato, etc.).
 *
 * Pré-requisitos do INSERT (NOT NULL): nome, email, senha_hash, cpf,
 * data_admissao. Se faltar algum, registra warning e aborta.
 *
 * Retorna o id do colaborador criado, ou null em caso de falha.
 */
async function criarColaboradorAPartirDeAdmissao(
  prov: {
    nome: string | null;
    empresa_id: number | null;
    cargo_id: number | null;
    departamento_id: number | null;
    jornada_id: number | null;
  },
  cpf: string,
  solicitacaoId: string
): Promise<number | null> {
  // 1. Carrega formulário + dados + data_admissao da solicitação
  const solRes = await query<{
    dados: Record<string, unknown> | null;
    campos: unknown;
    data_admissao: string | null;
  }>(
    `SELECT s.dados, f.campos, s.data_admissao
       FROM people.solicitacoes_admissao s
       JOIN people.formularios_admissao f ON f.id = s.formulario_id
      WHERE s.id = $1`,
    [solicitacaoId]
  );
  if (solRes.rows.length === 0) {
    console.warn(`[admitido] Solicitação ${solicitacaoId} não encontrada — abortando criação`);
    return null;
  }
  const dados = solRes.rows[0].dados ?? {};
  const campos = mapCamposParaApi(solRes.rows[0].campos, true);
  const dataAdmissao = solRes.rows[0].data_admissao ?? new Date().toISOString().slice(0, 10);

  // 2. Extrai todos os campos pessoais do JSONB
  const ext: CamposExtraidos = await extrairCamposPessoaisParaColaborador(campos, dados);

  // 3. Validações dos campos NOT NULL
  if (!prov.nome || !prov.nome.trim()) {
    console.warn(`[admitido] Provisório sem nome — abortando criação (solicitação ${solicitacaoId})`);
    return null;
  }
  if (!ext.email) {
    console.warn(`[admitido] E-mail não encontrado no formulário — abortando criação (solicitação ${solicitacaoId})`);
    return null;
  }
  if (!ext.senha) {
    console.warn(`[admitido] Senha não encontrada no formulário — abortando criação (solicitação ${solicitacaoId})`);
    return null;
  }

  // 4. Conflito de e-mail (CPF já foi pré-checado no handler)
  const emailConflict = await query<{ id: number }>(
    `SELECT id FROM people.colaboradores WHERE email = $1 LIMIT 1`,
    [ext.email]
  );
  if (emailConflict.rows.length > 0) {
    console.warn(
      `[admitido] E-mail "${ext.email}" já cadastrado (colaborador ${emailConflict.rows[0].id}) — abortando criação (solicitação ${solicitacaoId})`
    );
    return null;
  }

  // 5. Detecta tipo (admin/gestor/colaborador) pelo cargo
  let tipoUsuario = 'colaborador';
  if (prov.cargo_id) {
    const cargoRes = await query<{ nome: string }>(
      `SELECT nome FROM people.cargos WHERE id = $1`,
      [prov.cargo_id]
    );
    if (cargoRes.rows.length > 0) {
      tipoUsuario = detectarTipoPorCargo(cargoRes.rows[0].nome);
    }
  }

  const senhaHash = await hashPassword(ext.senha);

  // 6. INSERT
  const insertRes = await query<{ id: number }>(
    `INSERT INTO people.colaboradores (
       nome, email, senha_hash, cpf, rg, rg_orgao_emissor, rg_uf, telefone,
       cargo_id, tipo, empresa_id, departamento_id, jornada_id,
       data_admissao, data_nascimento, status,
       endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
       endereco_bairro, endereco_cidade, endereco_estado,
       estado_civil, formacao, cor_raca,
       banco_nome, banco_tipo_conta, banco_agencia, banco_conta, pix_tipo, pix_chave,
       vale_transporte, vale_alimentacao, auxilio_combustivel,
       uniforme_tamanho, altura_metros, peso_kg,
       contato_emergencia_nome, contato_emergencia_telefone
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14, $15, 'ativo',
       $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25,
       $26, $27, $28, $29, $30, $31,
       $32, $33, $34,
       $35, $36, $37,
       $38, $39
     )
     RETURNING id`,
    [
      prov.nome,
      ext.email,
      senhaHash,
      cpf,
      ext.rg ?? null,
      ext.rg_orgao_emissor ?? null,
      ext.rg_uf ?? null,
      ext.telefone ?? null,
      prov.cargo_id,
      tipoUsuario,
      prov.empresa_id,
      prov.departamento_id,
      prov.jornada_id,
      dataAdmissao,
      ext.data_nascimento ?? null,
      ext.endereco_cep ?? null,
      ext.endereco_logradouro ?? null,
      ext.endereco_numero ?? null,
      ext.endereco_complemento ?? null,
      ext.endereco_bairro ?? null,
      ext.endereco_cidade ?? null,
      ext.endereco_estado ?? null,
      ext.estado_civil ?? null,
      ext.formacao ?? null,
      ext.cor_raca ?? null,
      ext.banco_nome ?? null,
      ext.banco_tipo_conta ?? null,
      ext.banco_agencia ?? null,
      ext.banco_conta ?? null,
      ext.pix_tipo ?? null,
      ext.pix_chave ?? null,
      ext.vale_transporte ?? false,
      ext.vale_alimentacao ?? true,
      ext.auxilio_combustivel ?? false,
      ext.uniforme_tamanho ?? null,
      ext.altura_metros ?? null,
      ext.peso_kg ?? null,
      ext.contato_emergencia_nome ?? null,
      ext.contato_emergencia_telefone ?? null,
    ]
  );

  const novoId = insertRes.rows[0].id;

  // 7. Migra documentos da admissão pra documentos_colaborador
  await copiarDocumentosAdmissaoParaColaborador(novoId, solicitacaoId);

  // 8. Side-effects pós-INSERT
  await invalidateColaboradorCache();
  embedTableRowAfterInsert('colaboradores', novoId).catch((err) =>
    console.error('[admitido] Falha ao gerar embedding do colaborador:', err)
  );

  console.warn(
    `[admitido:${novoId}] Colaborador criado a partir da pré-admissão ${solicitacaoId} ` +
    `(cpf=${cpf}, tipo=${tipoUsuario})`
  );

  return novoId;
}

/**
 * Copia os documentos enviados na pré-admissão para documentos_colaborador.
 *
 * Reclassifica cada documento via IA (Claude) baseando-se no nome do arquivo
 * e no label do campo do formulário onde foi anexado. Isso resolve o caso
 * comum de candidato anexar uma CNH no campo "Documento de Identificação"
 * (que não tem tipo específico) e o documento ficar órfão na tabela do
 * colaborador. Documentos sem classificação clara caem em 'outros'.
 *
 * Diferente de substituirDocumentosNaReadmissao(), aqui é INSERT puro
 * (não há documentos antigos pra substituir).
 */
async function copiarDocumentosAdmissaoParaColaborador(
  colaboradorId: number,
  solicitacaoId: string
): Promise<void> {
  // 1. Carrega tipos de documento disponíveis (lookup por código)
  const tiposRes = await query<{ id: number; codigo: string; nome_exibicao: string }>(
    `SELECT id, codigo, nome_exibicao FROM people.tipos_documento_colaborador`
  );
  const tipos = tiposRes.rows;
  const tipoPorCodigo = new Map(tipos.map((t) => [t.codigo, t]));
  const tiposDisponiveis = tipos.map((t) => ({
    id: t.id,
    codigo: t.codigo,
    nomeExibicao: t.nome_exibicao,
  }));

  // 2. Busca TODOS os documentos da admissão (mesmo os sem tipo válido).
  //    LEFT JOIN garante que docs órfãos não sejam descartados.
  const docs = await query<{
    tipo_documento_id: number | null;
    codigo: string | null;
    nome_exibicao: string | null;
    nome: string;
    url: string;
    storage_key: string | null;
    tamanho: number | null;
  }>(
    `SELECT da.tipo_documento_id, t.codigo, t.nome_exibicao,
            da.nome, da.url, da.storage_key, da.tamanho
       FROM people.documentos_admissao da
       LEFT JOIN people.tipos_documento_colaborador t ON t.id = da.tipo_documento_id
      WHERE da.solicitacao_id = $1`,
    [solicitacaoId]
  );

  if (docs.rows.length === 0) return;

  // 3. Classifica cada documento via IA + heurística (paralelo)
  const classificacoes = await Promise.all(
    docs.rows.map(async (d) => {
      try {
        const codigo = await classificarTipoDocumento({
          nomeArquivo: d.nome,
          labelCampo: d.nome_exibicao,
          tipoOriginalCodigo: d.codigo,
          tiposDisponiveis,
        });
        return codigo;
      } catch (err) {
        console.error(`[admitido] Falha ao classificar "${d.nome}":`, err);
        return d.codigo ?? 'outros';
      }
    })
  );

  // 4. Persiste em documentos_colaborador com o tipo reclassificado
  let reclassificados = 0;
  for (let i = 0; i < docs.rows.length; i++) {
    const d = docs.rows[i];
    const codigoFinal = classificacoes[i];
    const tipoFinal = tipoPorCodigo.get(codigoFinal) ?? tipoPorCodigo.get('outros');
    if (!tipoFinal) {
      console.warn(`[admitido] Sem tipo "outros" no banco — documento "${d.nome}" não copiado`);
      continue;
    }
    if (d.codigo !== codigoFinal) reclassificados++;

    await query(
      `INSERT INTO people.documentos_colaborador
         (colaborador_id, tipo, tipo_documento_id, nome, url, storage_key, tamanho)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [colaboradorId, tipoFinal.codigo, tipoFinal.id, d.nome, d.url, d.storage_key, d.tamanho]
    );
  }

  console.warn(
    `[admitido] ${docs.rows.length} documento(s) copiado(s) para colaborador ${colaboradorId} ` +
    `(${reclassificados} reclassificado(s) por IA)`
  );
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
  // Senha NÃO entra: na readmissão preservamos a senha existente do colaborador,
  // que pode ter sido trocada via /alterar-senha desde o desligamento.
  const sobrescritosPessoais: string[] = [];
  const preservados: string[] = [];
  const mapa: [Exclude<keyof typeof extraidos, 'senha'>, string][] = [
    ['email',                       'email'],
    ['telefone',                    'telefone'],
    ['rg',                          'rg'],
    ['rg_orgao_emissor',            'rg_orgao_emissor'],
    ['rg_uf',                       'rg_uf'],
    ['data_nascimento',             'data_nascimento'],
    ['endereco_cep',                'endereco.cep'],
    ['endereco_logradouro',         'endereco.logradouro'],
    ['endereco_numero',             'endereco.numero'],
    ['endereco_complemento',        'endereco.complemento'],
    ['endereco_bairro',             'endereco.bairro'],
    ['endereco_cidade',             'endereco.cidade'],
    ['endereco_estado',             'endereco.estado'],
    ['vale_transporte',             'vale_transporte'],
    ['vale_alimentacao',            'vale_alimentacao'],
    ['auxilio_combustivel',         'auxilio_combustivel'],
    ['estado_civil',                'estado_civil'],
    ['formacao',                    'formacao'],
    ['cor_raca',                    'cor_raca'],
    ['banco_nome',                  'banco_nome'],
    ['banco_tipo_conta',            'banco_tipo_conta'],
    ['banco_agencia',               'banco_agencia'],
    ['banco_conta',                 'banco_conta'],
    ['pix_tipo',                    'pix_tipo'],
    ['pix_chave',                   'pix_chave'],
    ['uniforme_tamanho',            'uniforme_tamanho'],
    ['altura_metros',               'altura_metros'],
    ['peso_kg',                     'peso_kg'],
    ['contato_emergencia_nome',     'contato_emergencia_nome'],
    ['contato_emergencia_telefone', 'contato_emergencia_telefone'],
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
 * Na readmissão, reclassifica os documentos enviados via IA (mesma lógica
 * de copiarDocumentosAdmissaoParaColaborador) e substitui os documentos do
 * colaborador apenas dos tipos reclassificados — documentos de outros
 * tipos que o colaborador já tinha são preservados.
 */
async function substituirDocumentosNaReadmissao(
  colaboradorId: number,
  solicitacaoId: string
): Promise<void> {
  const tiposRes = await query<{ id: number; codigo: string; nome_exibicao: string }>(
    `SELECT id, codigo, nome_exibicao FROM people.tipos_documento_colaborador`
  );
  const tipos = tiposRes.rows;
  const tipoPorCodigo = new Map(tipos.map((t) => [t.codigo, t]));
  const tiposDisponiveis = tipos.map((t) => ({
    id: t.id,
    codigo: t.codigo,
    nomeExibicao: t.nome_exibicao,
  }));

  const novos = await query<{
    tipo_documento_id: number | null;
    codigo: string | null;
    nome_exibicao: string | null;
    nome: string;
    url: string;
    storage_key: string | null;
    tamanho: number | null;
  }>(
    `SELECT da.tipo_documento_id, t.codigo, t.nome_exibicao,
            da.nome, da.url, da.storage_key, da.tamanho
       FROM people.documentos_admissao da
       LEFT JOIN people.tipos_documento_colaborador t ON t.id = da.tipo_documento_id
      WHERE da.solicitacao_id = $1`,
    [solicitacaoId]
  );

  if (novos.rows.length === 0) return;

  // Reclassifica via IA em paralelo
  const codigos = await Promise.all(
    novos.rows.map(async (d) => {
      try {
        return await classificarTipoDocumento({
          nomeArquivo: d.nome,
          labelCampo: d.nome_exibicao,
          tipoOriginalCodigo: d.codigo,
          tiposDisponiveis,
        });
      } catch {
        return d.codigo ?? 'outros';
      }
    })
  );

  // Substitui documentos APENAS dos tipos reclassificados
  const tipoIdsReclassificados = Array.from(
    new Set(
      codigos
        .map((c) => tipoPorCodigo.get(c)?.id ?? tipoPorCodigo.get('outros')?.id)
        .filter((id): id is number => typeof id === 'number')
    )
  );
  if (tipoIdsReclassificados.length > 0) {
    await query(
      `DELETE FROM people.documentos_colaborador
        WHERE colaborador_id = $1
          AND tipo_documento_id = ANY($2::int[])`,
      [colaboradorId, tipoIdsReclassificados]
    );
  }

  for (let i = 0; i < novos.rows.length; i++) {
    const d = novos.rows[i];
    const tipoFinal = tipoPorCodigo.get(codigos[i]) ?? tipoPorCodigo.get('outros');
    if (!tipoFinal) continue;
    await query(
      `INSERT INTO people.documentos_colaborador
         (colaborador_id, tipo, tipo_documento_id, nome, url, storage_key, tamanho)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [colaboradorId, tipoFinal.codigo, tipoFinal.id, d.nome, d.url, d.storage_key, d.tamanho]
    );
  }

  console.warn(
    `[admitido] ${novos.rows.length} documento(s) substituído(s) no colaborador ${colaboradorId} (tipos: ${tipoIdsReclassificados.join(',')})`
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
