import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
} from '@/lib/api-response';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';

interface Params {
  params: Promise<{ id: string }>;
}

// Mensagem de pré-admissão ("instale o app") — mesma usada no envio inicial
// em POST /recrutamento/processos (caminho B). Sai pela instância padrão
// EVOLUTION_INSTANCE (a instância do DP / People), sem override de
// recrutamento — quem reenvia aqui é o DP, pelo modal de pré-admitidos.
function mensagemPreAdmissao(nome: string): string {
  const primeiroNome = (nome ?? '').split(' ')[0] || nome || 'Olá';
  return `Olá, ${primeiroNome}! Aqui é o João, do DP da Bluetech Window Films. Parabéns, você foi aprovado no nosso processo seletivo! 🎉

Para seguir com sua admissão, baixe o app *People*:

📱 iPhone: https://apps.apple.com/br/app/people-by-valeris/id6761028795
🤖 Android: https://play.google.com/store/apps/details?id=com.people.valeris

No 1º acesso, permita as autorizações, toque em *Área do colaborador → Primeiro acesso* e informe seu *CPF*.

Qualquer dúvida, estou à disposição. Salve nosso contato (DP) para receber informações futuras.`;
}

/**
 * POST /api/v1/admissao/solicitacoes/:id/reenviar-whatsapp
 *
 * Reenvia ao candidato a mensagem de pré-admissão (orientação pra instalar
 * o app e entrar com CPF). Disparado pelo DP no modal de pré-admitidos.
 *
 * Restrições:
 *  - Só permitido quando status = 'nao_acessado' ("Aguardando documentação"
 *    na UI) — depois disso o candidato já acessou o app e a mensagem de
 *    instalação não faz sentido.
 *  - Telefone do candidato vem do banco de Recrutamento (public.candidatos),
 *    resolvido via processo_seletivo.usuario_provisorio_id. Pré-admissões
 *    sem processo seletivo vinculado não têm telefone → 400.
 *
 * Envia pela instância Evolution padrão (EVOLUTION_INSTANCE = instância do
 * DP), sem override de recrutamento. Audita. Não altera o estado da
 * solicitação.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;

      const solRes = await query<{
        id: string;
        status: string;
        usuario_provisorio_id: number | null;
        provisorio_nome: string | null;
      }>(
        `SELECT s.id, s.status, s.usuario_provisorio_id,
                up.nome AS provisorio_nome
           FROM people.solicitacoes_admissao s
           LEFT JOIN people.usuarios_provisorios up ON up.id = s.usuario_provisorio_id
          WHERE s.id = $1
          LIMIT 1`,
        [id],
      );
      const sol = solRes.rows[0];
      if (!sol) return notFoundResponse('Pré-admissão não encontrada');

      if (sol.status !== 'nao_acessado') {
        return errorResponse(
          'Reenvio da mensagem de pré-admissão só é permitido enquanto a pré-admissão está em "Aguardando documentação".',
          409,
        );
      }

      if (!sol.usuario_provisorio_id) {
        return errorResponse('Pré-admissão sem usuário provisório vinculado', 400);
      }

      // Resolve o candidato de Recrutamento (telefone) via processo_seletivo.
      const psRes = await query<{ candidato_recrutamento_id: number | null }>(
        `SELECT candidato_recrutamento_id
           FROM people.processo_seletivo
          WHERE usuario_provisorio_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [sol.usuario_provisorio_id],
      );
      const candRecrutId = psRes.rows[0]?.candidato_recrutamento_id ?? null;
      if (!candRecrutId) {
        return errorResponse(
          'Não há processo seletivo vinculado a esta pré-admissão — telefone do candidato indisponível.',
          400,
        );
      }

      const candRes = await queryRecrutamento<{ nome: string | null; telefone: string | null }>(
        `SELECT nome, telefone FROM public.candidatos WHERE id = $1 LIMIT 1`,
        [candRecrutId],
      );
      const cand = candRes.rows[0];
      if (!cand) {
        return errorResponse('Candidato não encontrado no banco de Recrutamento', 404);
      }
      const numero = (cand.telefone ?? '').replace(/\D/g, '');
      if (!numero || numero.length < 10) {
        return errorResponse('Telefone do candidato indisponível ou inválido', 400);
      }

      const nomeMsg = sol.provisorio_nome || cand.nome || '';
      const texto = mensagemPreAdmissao(nomeMsg);

      const result = await enviarMensagemWhatsApp(numero, texto);
      const whatsappOk = result.ok;
      const whatsappErro = result.ok ? null : (result.erro ?? 'falha_desconhecida');

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'editar',
        modulo: 'admissao',
        descricao: `Reenvio da mensagem de pré-admissão (instalar app) da solicitação ${id}.`,
        dadosNovos: { solicitacaoId: id, status: sol.status, whatsappOk, whatsappErro },
      }));

      if (!whatsappOk) {
        return errorResponse(`Falha ao enviar WhatsApp: ${whatsappErro}`, 502);
      }

      return successResponse({ solicitacaoId: id, enviado: true });
    } catch (error) {
      console.error('[admissao/solicitacoes/:id/reenviar-whatsapp] erro:', error);
      return serverErrorResponse('Erro ao reenviar mensagem de pré-admissão');
    }
  });
}
