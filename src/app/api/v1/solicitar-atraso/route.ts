import { NextRequest } from 'next/server';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { solicitarAtrasoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateSolicitacaoCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { criarNotificacao } from '@/lib/notificacoes';
import { uploadArquivo } from '@/lib/storage';
import {
  obterJornadaDoDia,
  obterParametrosTolerancia,
  determinarProximoEvento,
  analisarAtraso,
  obterGestorDoColaborador,
  criarSolicitacaoAtraso,
} from '@/lib/tolerancia-atraso';
import { query } from '@/lib/db';

/**
 * POST /api/v1/solicitar-atraso
 *
 * Cria uma solicitação de atraso quando o colaborador está fora da tolerância
 * e escolhe notificar o gestor para autorizar o registro de ponto.
 *
 * Pré-condição: o endpoint /registrar-ponto retornou requerAprovacao=true.
 *
 * Fluxo:
 * 1. Revalida que o colaborador está de fato fora da tolerância
 * 2. Identifica o gestor responsável
 * 3. Cria solicitação tipo='atraso' com status='pendente'
 * 4. Notifica o gestor
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(solicitarAtrasoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;
      const agora = new Date();

      // Verificar colaborador
      const colaboradorResult = await query(
        `SELECT c.id, c.nome, c.departamento_id
         FROM bluepoint.bt_colaboradores c
         WHERE c.id = $1 AND c.status = 'ativo'`,
        [data.colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      const colaborador = colaboradorResult.rows[0];

      // Verificar se já existe solicitação de atraso pendente para hoje
      const solicitacaoPendente = await query(
        `SELECT id FROM bluepoint.bt_solicitacoes
         WHERE colaborador_id = $1
           AND tipo = 'atraso'
           AND status = 'pendente'
           AND data_evento = CURRENT_DATE
         LIMIT 1`,
        [data.colaboradorId]
      );

      if (solicitacaoPendente.rows.length > 0) {
        return errorResponse(
          'Já existe uma solicitação de atraso pendente para hoje. Aguarde a resposta do gestor.',
          409
        );
      }

      // Buscar jornada e revalidar atraso
      const jornada = await obterJornadaDoDia(data.colaboradorId);
      if (!jornada) {
        return errorResponse('Colaborador não possui jornada configurada', 400);
      }

      const evento = await determinarProximoEvento(data.colaboradorId, jornada);

      // Buscar parâmetros globais de tolerância
      const parametros = await obterParametrosTolerancia();

      const analise = await analisarAtraso(
        data.colaboradorId,
        parametros,
        evento.tipoMarcacao,
        evento.horarioPrevisto,
        evento.periodoIndex,
        agora
      );

      // Deve estar de fato fora da tolerância
      if (!analise.atrasado || analise.registrarNormalmente) {
        return errorResponse(
          'Colaborador está dentro da tolerância. Use o endpoint /registrar-ponto para registrar normalmente.',
          400
        );
      }

      // Identificar gestor
      const gestor = await obterGestorDoColaborador(data.colaboradorId);
      if (!gestor) {
        return errorResponse(
          'Não foi possível identificar um gestor responsável. Contate o RH.',
          400
        );
      }

      // Upload da foto (se enviada)
      let fotoUrl: string | null = null;
      if (data.foto) {
        try {
          const base64Data = data.foto.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');

          let extensao = 'jpg';
          let contentType = 'image/jpeg';
          if (data.foto.startsWith('data:image/png')) {
            extensao = 'png';
            contentType = 'image/png';
          }

          const dataFormatada = agora.toISOString().split('T')[0];
          const timestamp = agora.getTime();
          const caminho = `solicitacoes-atraso/${data.colaboradorId}/${dataFormatada}/${timestamp}.${extensao}`;

          fotoUrl = await uploadArquivo(caminho, buffer, contentType);
        } catch (uploadError) {
          console.warn('Erro ao fazer upload da foto:', uploadError);
        }
      }

      // Criar solicitação
      const solicitacaoId = await criarSolicitacaoAtraso({
        colaboradorId: data.colaboradorId,
        gestorId: gestor.id,
        horarioSolicitacao: agora,
        horarioPrevisto: analise.horarioPrevisto,
        atrasoMinutos: analise.atrasoMinutos,
        justificativa: data.justificativa,
        tipoMarcacao: evento.tipoMarcacao,
        periodoIndex: evento.periodoIndex,
        metodo: data.metodo,
        latitude: data.localizacao?.latitude,
        longitude: data.localizacao?.longitude,
        fotoUrl: fotoUrl || undefined,
        empresaId: data.empresaId || undefined,
      });

      // Notificar gestor
      await criarNotificacao({
        usuarioId: gestor.id,
        tipo: 'solicitacao',
        titulo: 'Solicitação de registro com atraso',
        mensagem:
          `${colaborador.nome} está com ${analise.atrasoMinutos} minutos de atraso ` +
          `(previsto: ${analise.horarioPrevisto}, tentativa: ${analise.horarioTentativa}) ` +
          `e solicita autorização para registro de ponto. Justificativa: "${data.justificativa}"`,
        link: `/solicitacoes/${solicitacaoId}`,
        metadados: {
          acao: 'aprovar_atraso',
          solicitacaoId,
          colaboradorId: data.colaboradorId,
          colaboradorNome: colaborador.nome,
          atrasoMinutos: analise.atrasoMinutos,
          horarioPrevisto: analise.horarioPrevisto,
          horarioTentativa: analise.horarioTentativa,
          tipoMarcacao: evento.tipoMarcacao,
        },
      });

      // Invalidar cache
      await invalidateSolicitacaoCache(solicitacaoId, data.colaboradorId);
      await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);

      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'registro_ponto',
        descricao: `Solicitação de atraso criada: ${colaborador.nome} (${analise.atrasoMinutos}min atraso)`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          solicitacaoId,
          colaboradorId: data.colaboradorId,
          gestorId: gestor.id,
          atrasoMinutos: analise.atrasoMinutos,
          horarioPrevisto: analise.horarioPrevisto,
          tipoMarcacao: evento.tipoMarcacao,
        },
      });

      return createdResponse({
        solicitacaoId,
        status: 'pendente',
        gestorNotificado: {
          id: gestor.id,
          nome: gestor.nome,
        },
        atraso: {
          minutos: analise.atrasoMinutos,
          horarioPrevisto: analise.horarioPrevisto,
          horarioTentativa: analise.horarioTentativa,
          tipoMarcacao: evento.tipoMarcacao,
        },
        mensagem:
          'Solicitação de registro de ponto enviada ao gestor. ' +
          'Você será notificado quando houver uma resposta.',
      });
    } catch (error) {
      console.error('Erro ao criar solicitação de atraso:', error);
      return serverErrorResponse('Erro ao criar solicitação de atraso');
    }
  });
}
