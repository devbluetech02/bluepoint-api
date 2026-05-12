import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import {
  createdResponse,
  errorResponse,
  serverErrorResponse,
  validationErrorResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';
import { enviarPushParaColaborador } from '@/lib/push-colaborador';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

// =====================================================
// POST /api/v1/atualizacao-cadastral/solicitar
//
// Cria solicitação de atualização cadastral.
//
// Fluxo novo (sem form builder): o gestor seleciona, no front,
// quais CAMPOS do modal de detalhes do colaborador devem ser
// atualizados (`campos`) e/ou quais TIPOS DE DOCUMENTO devem
// ser anexados (`tiposDocumento`). A solicitação carrega a
// própria lista — não depende mais de um template global.
//
// Body:
//   { colaboradorId: number,
//     campos: string[],               // keys do modal (ex.: "nome","endereco_cep")
//     tiposDocumento?: number[],      // IDs em people.tipos_documento_colaborador
//     mensagemWhatsApp?: string|null  // opcional, override do template padrão
//   }
//
// Exige pelo menos um campo OU um tipo de documento.
// =====================================================

const schema = z.object({
  colaboradorId: z.number().int().positive('colaboradorId é obrigatório'),
  campos: z.array(z.string().min(1)).default([]),
  tiposDocumento: z.array(z.number().int().positive()).default([]),
  mensagemWhatsApp: z.string().max(2000).optional().nullable(),
}).refine(
  (v) => v.campos.length > 0 || v.tiposDocumento.length > 0,
  { message: 'Selecione ao menos 1 campo ou tipo de documento', path: ['campos'] },
);

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      const validation = validateBody(schema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }
      const { colaboradorId, campos, tiposDocumento, mensagemWhatsApp } = validation.data;
      const criadorId: number | null = user.userId ?? null;

      // Colaborador existe?
      const colabResult = await query<{ id: number; nome: string; telefone: string | null }>(
        `SELECT id, nome, telefone
           FROM people.colaboradores
          WHERE id = $1`,
        [colaboradorId],
      );
      if (colabResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }
      const colaborador = colabResult.rows[0];

      // 3. Cria solicitação.
      const token = crypto.randomBytes(24).toString('hex');
      const insert = await query<{ id: string }>(
        `INSERT INTO people.solicitacoes_atualizacao_cadastral
           (colaborador_id, token, campos_solicitados, tipos_documento_ids,
            mensagem_whatsapp, status, criado_por)
         VALUES ($1, $2, $3::jsonb, $4::int[], $5, 'pendente', $6)
         RETURNING id::text`,
        [
          colaboradorId,
          token,
          JSON.stringify(campos),
          tiposDocumento,
          mensagemWhatsApp ?? null,
          criadorId,
        ],
      );
      const solicitacaoId = insert.rows[0].id;

      const link = `https://people.valerisapp.com.br/?page=atualizacao&token=${token}`;

      // 4. WhatsApp (best-effort).
      let whatsappEnviado = false;
      if (colaborador.telefone) {
        const primeiroNome = colaborador.nome.split(' ')[0];
        const corpo = mensagemWhatsApp && mensagemWhatsApp.trim() !== ''
          ? `${mensagemWhatsApp}\n\n${link}`
          : `Olá, ${primeiroNome}! 👋\n\n` +
            `Precisamos que você atualize alguns dados cadastrais. ` +
            `É rápido e pode ser feito pelo celular:\n\n` +
            `📋 *Atualizar dados:*\n${link}\n\n` +
            `Qualquer dúvida, fale com o RH. Obrigado! 💙`;
        const r = await enviarMensagemWhatsApp(colaborador.telefone, corpo);
        whatsappEnviado = r.ok;
        if (r.ok) {
          await query(
            `UPDATE people.solicitacoes_atualizacao_cadastral
                SET status = 'enviado'
              WHERE id = $1::bigint`,
            [solicitacaoId],
          );
        }
      }

      // 5. Push (best-effort).
      enviarPushParaColaborador(colaboradorId, {
        titulo: 'Atualização Cadastral',
        mensagem: 'O RH solicitou que você atualize seus dados cadastrais. Toque para abrir.',
        severidade: 'atencao',
        url: link,
      }).catch(() => {});

      return createdResponse({
        id: solicitacaoId,
        token,
        link,
        whatsappEnviado,
      });
    } catch (error) {
      console.error('[atualizacao-cadastral/solicitar] erro:', error);
      return serverErrorResponse('Erro ao solicitar atualização cadastral');
    }
  });
}
