import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';
import { enviarDocumentoDiaTeste } from '@/lib/recrutamento-dia-teste';

// POST /api/v1/recrutamento/processos/:id/reenviar-whatsapp
//
// Reenvia ao candidato a mensagem de WhatsApp original do processo —
// útil quando o candidato apagou, não recebeu ou bloqueou o número
// na primeira tentativa.
//
// Funciona pros dois caminhos:
//   - dia_teste:    busca o signing_link do contrato no SignProof
//                   (reusa o documento existente, sem custo extra) e
//                   reenvia a mensagem com o link.
//   - pre_admissao: reenvia a mensagem padrão com link do app + CPF.
//
// Não recria documento, não cria provisório, não toca no estado do
// processo — só dispara WhatsApp. Audita.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;

      const procResult = await query<{
        id: string;
        caminho: string;
        status: string;
        candidato_recrutamento_id: number | null;
        documento_assinatura_id: string | null;
      }>(
        `SELECT id::text, caminho, status,
                candidato_recrutamento_id, documento_assinatura_id
           FROM people.processo_seletivo
          WHERE id = $1::bigint
          LIMIT 1`,
        [id]
      );
      const proc = procResult.rows[0];
      if (!proc) return notFoundResponse('Processo seletivo não encontrado');

      if (proc.status === 'cancelado' || proc.status === 'admitido') {
        return errorResponse(
          `Processo já está ${proc.status} — reenvio não se aplica`,
          409
        );
      }

      if (!proc.candidato_recrutamento_id) {
        return errorResponse('Processo sem candidato vinculado', 400);
      }

      const candResult = await queryRecrutamento<{
        nome: string;
        telefone: string | null;
      }>(
        `SELECT nome, telefone FROM public.candidatos WHERE id = $1 LIMIT 1`,
        [proc.candidato_recrutamento_id]
      );
      const cand = candResult.rows[0];
      if (!cand) {
        return errorResponse(
          'Candidato não encontrado no banco de Recrutamento',
          404
        );
      }
      const numero = (cand.telefone ?? '').replace(/\D/g, '');
      if (!numero || numero.length < 10) {
        return errorResponse(
          'Telefone do candidato indisponível ou inválido',
          400
        );
      }

      const primeiroNome = cand.nome.split(' ')[0] || cand.nome;

      let whatsappOk = false;
      let whatsappErro: string | null = null;
      let signingLink: string | undefined;

      if (proc.caminho === 'dia_teste') {
        if (!proc.documento_assinatura_id) {
          return errorResponse(
            'Processo de dia de teste sem contrato gerado — não há link pra reenviar',
            400
          );
        }
        const env = await enviarDocumentoDiaTeste(proc.documento_assinatura_id);
        if (!env.ok || !env.signingLink) {
          return errorResponse(
            `Não foi possível obter o link de assinatura: ${env.erro ?? 'sem signing_link'}`,
            502
          );
        }
        signingLink = env.signingLink;
        const msg = [
          `Olá, ${primeiroNome}! 👋`,
          '',
          'Reenviando o link pra você assinar o contrato do dia de teste:',
          '',
          '📋 *Assinar contrato:*',
          signingLink,
          '',
          'Qualquer dúvida, estamos à disposição!',
        ].join('\n');
        const result = await enviarMensagemWhatsApp(numero, msg);
        whatsappOk = result.ok;
        whatsappErro = result.ok ? null : (result.erro ?? 'falha_desconhecida');
      } else if (proc.caminho === 'pre_admissao') {
        const msg = `Olá, ${primeiroNome}! 👋

Reforçando o link pra você seguir com sua admissão.

Baixe o app *People*:

📱 iPhone: https://apps.apple.com/br/app/people-by-valeris/id6761028795
🤖 Android: https://play.google.com/store/apps/details?id=com.people.valeris

No 1º acesso, permita as autorizações, toque em *Área do colaborador → Primeiro acesso* e informe seu *CPF*.

Qualquer dúvida, estamos à disposição.`;
        const result = await enviarMensagemWhatsApp(numero, msg);
        whatsappOk = result.ok;
        whatsappErro = result.ok ? null : (result.erro ?? 'falha_desconhecida');
      } else {
        return errorResponse(
          `Caminho do processo desconhecido: ${proc.caminho}`,
          400
        );
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'recrutamento_processo_seletivo',
        descricao: `Reenvio de WhatsApp do processo ${id} (caminho ${proc.caminho}).`,
        dadosNovos: {
          processoId: id,
          caminho: proc.caminho,
          whatsappOk,
          whatsappErro,
          comSigningLink: !!signingLink,
        },
      }));

      if (!whatsappOk) {
        return errorResponse(
          `Falha ao enviar WhatsApp: ${whatsappErro ?? 'desconhecido'}`,
          502
        );
      }

      return successResponse({
        processoId: id,
        caminho: proc.caminho,
        enviado: true,
      });
    } catch (error) {
      console.error('[recrutamento/processos/:id/reenviar-whatsapp] erro:', error);
      return serverErrorResponse('Erro ao reenviar WhatsApp');
    }
  });
}
