import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';

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
  aguardando_rh:          'Sua solicitação está sendo analisada pelo RH.',
  correcao_solicitada:    'Alguns itens precisam ser corrigidos. Abra o app para revisar.',
  aso_solicitado:         'Seu exame admissional foi agendado. Verifique os detalhes no app.',
  aso_recebido:           'Seu ASO foi recebido. Em breve você terá uma atualização.',
  em_teste:               'Você está em período de teste. Boa sorte!',
  aso_reprovado:          'O resultado do seu ASO foi considerado inapto. O RH entrará em contato.',
  assinatura_solicitada:  'Seu contrato está pronto para assinatura. Acesse o app para assinar.',
  contrato_assinado:      'Contrato assinado com sucesso! Aguarde os próximos passos.',
  admitido:               'Bem-vindo! Sua admissão foi concluída.',
  rejeitado:              'Sua candidatura não prosseguirá. O RH pode entrar em contato com mais detalhes.',
};

/**
 * GET /api/v1/admissao/solicitacoes/:id
 */
export async function GET(request: NextRequest, { params }: Params) {
  return withAdmissao(request, async () => {
    try {
      const { id } = await params;

      const solicitacaoResult = await query(
        `SELECT
           s.id,
           s.formulario_id,
           s.status,
           s.dados,
           s.clinica_id,
           s.data_exame_aso,
           s.mensagem_aso,
           s.aso_solicitado_em,
           s.criado_em,
           s.atualizado_em,
           s.usuario_provisorio_id,
           s.pendencias_correcao,
           s.foto_perfil_url,
           f.titulo AS formulario_titulo,
           cl.nome        AS clinica_nome,
           cl.logradouro  AS clinica_logradouro,
           cl.numero      AS clinica_numero,
           cl.bairro      AS clinica_bairro,
           cl.cidade      AS clinica_cidade,
           cl.estado      AS clinica_estado,
           cl.cep         AS clinica_cep,
           up.cpf         AS candidato_cpf,
           up.dias_teste  AS candidato_dias_teste,
           cg.nome        AS candidato_cargo,
           bfp.foto_referencia_url AS biometria_foto_referencia_url,
           bfp.qualidade           AS biometria_qualidade,
           bfp.frames_urls         AS biometria_frames_urls,
           bfp.created_at          AS biometria_criado_em
         FROM people.solicitacoes_admissao s
         JOIN people.formularios_admissao f ON f.id = s.formulario_id
         LEFT JOIN people.clinicas cl ON cl.id = s.clinica_id
         LEFT JOIN people.usuarios_provisorios up ON up.id = s.usuario_provisorio_id
         LEFT JOIN people.cargos cg ON cg.id = up.cargo_id
         LEFT JOIN people.biometria_facial_pendente bfp ON bfp.solicitacao_id = s.id
         WHERE s.id = $1`,
        [id]
      );

      if (solicitacaoResult.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const s = solicitacaoResult.rows[0];

      const STATUS_ASO = new Set(['aso_solicitado', 'aso_recebido']);
      function buildEndereco(): string {
        const partes: string[] = [];
        if (s.clinica_logradouro) partes.push(s.clinica_logradouro);
        if (s.clinica_numero) partes.push(`, ${s.clinica_numero}`);
        if (s.clinica_bairro) partes.push(` — ${s.clinica_bairro}`);
        if (s.clinica_cidade && s.clinica_estado) partes.push(`, ${s.clinica_cidade}/${s.clinica_estado}`);
        else if (s.clinica_cidade) partes.push(`, ${s.clinica_cidade}`);
        if (s.clinica_cep) partes.push(`, ${s.clinica_cep}`);
        return partes.join('');
      }

      let aso: Record<string, unknown> | null = null;
      if (STATUS_ASO.has(s.status) && s.clinica_id) {
        aso = {
          clinica:  s.clinica_nome,
          endereco: buildEndereco(),
        };
        if (s.data_exame_aso) aso.dataHora = new Date(s.data_exame_aso).toISOString();
        if (s.mensagem_aso)   aso.observacoes = s.mensagem_aso;
      }

      const docsResult = await query(
        `SELECT
           d.id,
           d.tipo_documento_id,
           t.codigo,
           t.nome_exibicao AS label,
           d.nome,
           d.url,
           d.tamanho,
           d.criado_em
         FROM people.documentos_admissao d
         JOIN people.tipos_documento_colaborador t ON t.id = d.tipo_documento_id
         WHERE d.solicitacao_id = $1
         ORDER BY d.criado_em ASC`,
        [id]
      );

      const documentos = docsResult.rows.map((d) => ({
        id:              d.id,
        tipoDocumentoId: d.tipo_documento_id,
        codigo:          d.codigo,
        label:           d.label,
        nome:            d.nome,
        url:             d.url,
        tamanho:         d.tamanho,
        criadoEm:        d.criado_em,
      }));

      const fotoPerfil = s.foto_perfil_url ? { url: s.foto_perfil_url as string } : null;

      const biometriaFacial = s.biometria_foto_referencia_url
        ? {
            fotoReferenciaUrl: s.biometria_foto_referencia_url as string,
            qualidade:         s.biometria_qualidade != null ? Number(s.biometria_qualidade) : null,
            framesUrls:        (s.biometria_frames_urls as string[] | null) ?? [],
            criadoEm:          s.biometria_criado_em,
          }
        : null;

      return successResponse({
        id:                  s.id,
        formularioId:        s.formulario_id,
        formularioTitulo:    s.formulario_titulo,
        status:              s.status,
        dados:               s.dados,
        candidato: {
          cpf:       s.candidato_cpf        ?? null,
          cargo:     s.candidato_cargo      ?? null,
          diasTeste: s.candidato_dias_teste ?? null,
        },
        diasTeste: s.candidato_dias_teste ?? null,
        ...(aso ? { aso } : {}),
        documentos,
        ...(fotoPerfil       ? { fotoPerfil }       : {}),
        ...(biometriaFacial  ? { biometriaFacial }  : {}),
        pendenciasCorrecao:  s.pendencias_correcao ?? null,
        usuarioProvisorioId: s.usuario_provisorio_id,
        criadoEm:            s.criado_em,
        atualizadoEm:        s.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao obter solicitação de admissão:', error);
      return serverErrorResponse('Erro ao obter solicitação de admissão');
    }
  });
}

/**
 * PATCH /api/v1/admissao/solicitacoes/:id
 *
 * Body padrão:  { status?, dados? }
 * Body aso_solicitado: { status: "aso_solicitado", mensagemAso: string, clinicaId?: string, dataExame?: string }
 *
 * Fluxo: aguardando_rh → aso_solicitado → aso_recebido → [em_teste] → assinatura_solicitada → contrato_assinado → admitido
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAdmissao(request, async (req) => {
    try {
      const { id } = await params;

      const body = await req.json().catch(() => null);
      if (!body || (body.status === undefined && body.dados === undefined)) {
        return errorResponse('Informe "status" e/ou "dados" para atualizar', 400);
      }

      if (body.status !== undefined && !STATUS_VALIDOS.includes(body.status)) {
        return errorResponse(
          `Status inválido. Valores aceitos: ${STATUS_VALIDOS.join(', ')}`,
          400
        );
      }

      if (body.dados !== undefined && (typeof body.dados !== 'object' || Array.isArray(body.dados))) {
        return errorResponse('"dados" deve ser um objeto', 400);
      }

      const sets: string[] = ['atualizado_em = NOW()'];
      const values: unknown[] = [];

      if (body.status !== undefined) {
        values.push(body.status);
        sets.push(`status = $${values.length}`);
      }

      if (body.dados !== undefined) {
        values.push(JSON.stringify(body.dados));
        sets.push(`dados = $${values.length}::jsonb`);
      }

      values.push(id);
      const result = await query(
        `UPDATE people.solicitacoes_admissao
            SET ${sets.join(', ')}
          WHERE id = $${values.length}
          RETURNING id, status, dados, usuario_provisorio_id, onesignal_subscription_id, atualizado_em`,
        values
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const sol = result.rows[0];

      // Push para o candidato se status mudou
      if (body.status !== undefined && sol.usuario_provisorio_id) {
        enviarPushParaProvisorio(sol.usuario_provisorio_id, {
          titulo:     'Atualização na sua pré-admissão',
          mensagem:   STATUS_MENSAGEM[sol.status as StatusAdmissao],
          severidade: sol.status === 'admitido' ? 'info' : 'atencao',
          data: { acao: 'admissao_status', solicitacaoId: sol.id, status: sol.status },
        }, sol.onesignal_subscription_id).catch(console.error);
      }

      return successResponse({
        id:          sol.id,
        status:      sol.status,
        dados:       sol.dados,
        atualizadoEm: sol.atualizado_em,
      });
    } catch (error) {
      console.error('Erro ao atualizar solicitação:', error);
      return serverErrorResponse('Erro ao atualizar solicitação');
    }
  });
}
