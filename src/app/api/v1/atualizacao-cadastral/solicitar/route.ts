import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { enviarMensagemWhatsApp } from '@/lib/evolution-api';
import { enviarPushParaColaborador } from '@/lib/push-colaborador';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';

// =====================================================
// Schema
// =====================================================

const solicitarAtualizacaoCadastralSchema = z.object({
  colaboradorId: z.number().int().positive('colaboradorId é obrigatório'),
  camposSelecionados: z.array(z.string()).min(1, 'Selecione pelo menos 1 campo'),
  documentosSelecionados: z.array(z.number().int().positive()).default([]),
  mensagemWhatsApp: z.string().max(2000).optional().nullable(),
});

// =====================================================
// POST — cria uma nova solicitação de atualização cadastral
// =====================================================

export async function POST(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const body = await req.json();
      const validation = validateBody(solicitarAtualizacaoCadastralSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { colaboradorId, camposSelecionados, documentosSelecionados, mensagemWhatsApp } = validation.data;

      // Buscar dados do colaborador
      const colabResult = await query(
        `SELECT id, nome, telefone
         FROM people.colaboradores
         WHERE id = $1`,
        [colaboradorId]
      );

      if (colabResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      const colaborador = colabResult.rows[0] as { id: number; nome: string; telefone: string | null };

      // Buscar formulário ativo (ou criar um default se não existir)
      let formularioId: string;
      const formResult = await query<{ id: string }>(
        `SELECT id FROM people.formularios_atualizacao_cadastral WHERE ativo = true ORDER BY criado_em DESC LIMIT 1`
      );
      if (formResult.rows.length > 0) {
        formularioId = formResult.rows[0].id;
      } else {
        const newForm = await query<{ id: string }>(
          `INSERT INTO people.formularios_atualizacao_cadastral (titulo, campos, ativo)
           VALUES ('Atualização Cadastral', '[]'::jsonb, true)
           RETURNING id`
        );
        formularioId = newForm.rows[0].id;
      }

      // Gerar token público
      const tokenPublico = crypto.randomBytes(24).toString('hex');

      // Calcular expiração (7 dias)
      const expiraEm = new Date();
      expiraEm.setDate(expiraEm.getDate() + 7);

      // Inserir solicitação
      const insertResult = await query(
        `INSERT INTO people.solicitacoes_atualizacao_cadastral
           (formulario_id, colaborador_id, campos_selecionados, documentos_selecionados, token_publico, status, expira_em)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'pendente', $6)
         RETURNING id`,
        [
          formularioId,
          colaboradorId,
          JSON.stringify(camposSelecionados),
          JSON.stringify(documentosSelecionados),
          tokenPublico,
          expiraEm.toISOString(),
        ]
      );

      const solicitacaoId = insertResult.rows[0].id;

      // Montar link público
      const link = `https://people.valerisapp.com.br/?page=atualizacao&token=${tokenPublico}`;

      // Enviar WhatsApp
      let whatsappEnviado = false;

      if (colaborador.telefone) {
        const primeiroNome = colaborador.nome.split(' ')[0];

        let mensagem: string;
        if (mensagemWhatsApp) {
          mensagem = `${mensagemWhatsApp}\n\n${link}`;
        } else {
          mensagem =
            `Olá, ${primeiroNome}! 👋\n\n` +
            `Precisamos que você atualize alguns dados cadastrais. É rápido e pode ser feito pelo celular:\n\n` +
            `📋 *Atualizar dados:*\n${link}\n\n` +
            `Qualquer dúvida, fale com o RH. Obrigado! 💙`;
        }

        const resultado = await enviarMensagemWhatsApp(colaborador.telefone, mensagem);
        whatsappEnviado = resultado.ok;

        if (resultado.ok) {
          await query(
            `UPDATE people.solicitacoes_atualizacao_cadastral
             SET status = 'enviado'
             WHERE id = $1`,
            [solicitacaoId]
          );
        }
      }

      // Push notification no app (best-effort)
      enviarPushParaColaborador(colaboradorId, {
        titulo: 'Atualização Cadastral',
        mensagem: 'O RH solicitou que você atualize seus dados cadastrais. Toque para abrir.',
        severidade: 'atencao',
        url: link,
      }).catch(() => {});

      return createdResponse({
        id: solicitacaoId,
        token: tokenPublico,
        link,
        whatsappEnviado,
      });
    } catch (error) {
      console.error('Erro ao solicitar atualização cadastral:', error);
      return serverErrorResponse('Erro ao solicitar atualização cadastral');
    }
  });
}
