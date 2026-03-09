import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse, successResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarPontoComToleranciaSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateMarcacaoCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { uploadArquivo } from '@/lib/storage';
import {
  obterJornadaDoDia,
  obterParametrosTolerancia,
  determinarProximoEvento,
  analisarAtraso,
  registrarAtrasoTolerado,
} from '@/lib/tolerancia-atraso';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

/**
 * POST /api/v1/registrar-ponto
 *
 * Endpoint unificado de registro de ponto com controle de tolerância de atraso.
 *
 * Fluxo:
 * 1. Identifica a escala/horário previsto do colaborador
 * 2. Determina qual evento está ativo (entrada, almoço, retorno, saída)
 * 3. Para entrada/retorno: calcula atraso e verifica tolerância
 *    - Dentro da tolerância → registra ponto normalmente
 *    - Fora da tolerância  → retorna dados para o cliente exibir a tela de solicitação
 * 4. Para almoço/saída: registra normalmente (sem controle de atraso de entrada)
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = validateBody(registrarPontoComToleranciaSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;
      const agora = new Date();

      // Verificar se colaborador existe e está ativo
      const colaboradorResult = await query(
        `SELECT c.id, c.nome, c.jornada_id, c.empresa_id,
                c.permite_ponto_mobile, c.permite_ponto_qualquer_empresa
         FROM bluepoint.bt_colaboradores c
         WHERE c.id = $1 AND c.status = 'ativo'`,
        [data.colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      const colaborador = colaboradorResult.rows[0];

      // Verificar permissão de ponto pelo celular
      if (data.metodo === 'app' && !colaborador.permite_ponto_mobile) {
        return errorResponse('Este colaborador não tem permissão para marcar ponto pelo celular', 403);
      }

      // Verificar permissão de ponto em outra empresa
      if (data.empresaId && colaborador.empresa_id && data.empresaId !== colaborador.empresa_id && !colaborador.permite_ponto_qualquer_empresa) {
        return errorResponse('Este colaborador não tem permissão para marcar ponto em outra empresa', 403);
      }

      // Buscar jornada do dia
      const jornada = await obterJornadaDoDia(data.colaboradorId);

      if (!jornada) {
        return errorResponse('Colaborador não possui jornada configurada ou hoje é folga', 400);
      }

      if (jornada.folga) {
        return errorResponse('Hoje é dia de folga na jornada do colaborador', 400);
      }

      // Determinar próximo evento
      const evento = await determinarProximoEvento(data.colaboradorId, jornada);

      // Validar sequência de marcações
      const ultimaMarcacao = evento.marcacoesHoje.length > 0
        ? evento.marcacoesHoje[evento.marcacoesHoje.length - 1]
        : null;

      if (evento.tipoMarcacao === 'entrada' || evento.tipoMarcacao === 'retorno') {
        if (ultimaMarcacao && (ultimaMarcacao.tipo === 'entrada' || ultimaMarcacao.tipo === 'retorno')) {
          return errorResponse('Já existe uma entrada registrada. Registre a saída primeiro.', 400);
        }
      }

      if (evento.tipoMarcacao === 'saida' || evento.tipoMarcacao === 'almoco') {
        if (!ultimaMarcacao || (ultimaMarcacao.tipo === 'saida' || ultimaMarcacao.tipo === 'almoco')) {
          return errorResponse('Registre a entrada primeiro.', 400);
        }
      }

      // Buscar parâmetros globais de tolerância
      const parametros = await obterParametrosTolerancia();

      // Analisar atraso (só relevante para entrada/retorno)
      const analise = await analisarAtraso(
        data.colaboradorId,
        parametros,
        evento.tipoMarcacao,
        evento.horarioPrevisto,
        evento.periodoIndex,
        agora
      );

      // Se atrasado e FORA da tolerância → não registra, retorna pedido de aprovação
      if (analise.atrasado && !analise.registrarNormalmente) {
        return successResponse({
          registrado: false,
          requerAprovacao: true,
          tipoMarcacao: evento.tipoMarcacao,
          atraso: {
            minutos: analise.atrasoMinutos,
            horarioPrevisto: analise.horarioPrevisto,
            horarioTentativa: analise.horarioTentativa,
            toleranciaPeriodoMin: analise.toleranciaPeriodoMin,
            toleranciaDiariaMaxMin: analise.toleranciaDiariaMaxMin,
            toleranciaDiariaJaUsada: analise.toleranciaDiariaJaUsada,
            toleranciaDiariaRestante: analise.toleranciaDiariaRestante,
            dentroToleranciaPeriodo: analise.dentroToleranciaPeriodo,
            dentroToleranciaDiaria: analise.dentroToleranciaDiaria,
          },
          mensagem:
            'Você está atrasado e está fora da tolerância permitida. ' +
            'Deseja notificar o seu gestor para autorizar o registro de ponto?',
        });
      }

      // Upload da foto para MinIO (se enviada)
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
          const caminho = `marcacoes/${data.colaboradorId}/${dataFormatada}/${timestamp}_${evento.tipoMarcacao}.${extensao}`;

          fotoUrl = await uploadArquivo(caminho, buffer, contentType);
        } catch (uploadError) {
          console.warn('Erro ao fazer upload da foto:', uploadError);
        }
      }

      // Registrar ponto normalmente
      const result = await query(
        `INSERT INTO bluepoint.bt_marcacoes (
          colaborador_id, empresa_id, data_hora, tipo, latitude, longitude, metodo, foto_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, data_hora`,
        [
          data.colaboradorId,
          data.empresaId || null,
          agora,
          evento.tipoMarcacao,
          data.localizacao?.latitude || null,
          data.localizacao?.longitude || null,
          data.metodo,
          fotoUrl,
        ]
      );

      const marcacao = result.rows[0];
      embedTableRowAfterInsert('bt_marcacoes', marcacao.id).catch(() => {});

      // Se houve atraso tolerado, registrar no controle interno
      if (analise.atrasado && analise.registrarNormalmente && analise.atrasoMinutos > 0) {
        try {
          await registrarAtrasoTolerado(
            data.colaboradorId,
            evento.tipoMarcacao,
            analise.horarioPrevisto,
            agora,
            analise.atrasoMinutos,
            marcacao.id
          );
        } catch (err) {
          console.error('[Tolerância] Erro ao registrar atraso tolerado (não bloqueante):', err);
        }
      }

      // Invalidar cache
      await invalidateMarcacaoCache(data.colaboradorId);
      await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);

      // Determinar status e próxima marcação
      let status = 'no_horario';
      if (analise.atrasado && analise.atrasoMinutos > 0) {
        status = 'tolerado';
      }

      const proximaMarcacaoMap: Record<string, string | undefined> = {
        entrada: 'almoco',
        almoco: 'retorno',
        retorno: 'saida',
        saida: undefined,
      };

      // Registrar auditoria
      const tipoLabel: Record<string, string> = {
        entrada: 'Entrada registrada',
        almoco: 'Saída para almoço registrada',
        retorno: 'Retorno do almoço registrado',
        saida: 'Saída registrada',
      };

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'registro_ponto',
        descricao: `${tipoLabel[evento.tipoMarcacao] || 'Ponto registrado'}: ${colaborador.nome}${analise.atrasado ? ` (atraso tolerado: ${analise.atrasoMinutos}min)` : ''}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          marcacaoId: marcacao.id,
          colaboradorId: data.colaboradorId,
          tipo: evento.tipoMarcacao,
          status,
          atrasoMinutos: analise.atrasoMinutos,
          tolerado: analise.atrasado && analise.registrarNormalmente,
        },
      });

      return createdResponse({
        registrado: true,
        requerAprovacao: false,
        id: marcacao.id,
        dataHora: marcacao.data_hora,
        tipo: evento.tipoMarcacao,
        status,
        proximaMarcacao: proximaMarcacaoMap[evento.tipoMarcacao] || null,
        ...(analise.atrasado && {
          atraso: {
            minutos: analise.atrasoMinutos,
            tolerado: true,
            horarioPrevisto: analise.horarioPrevisto,
            horarioTentativa: analise.horarioTentativa,
            toleranciaDiariaRestante: Math.max(
              0,
              analise.toleranciaDiariaMaxMin - analise.toleranciaDiariaJaUsada - analise.atrasoMinutos
            ),
          },
        }),
      });
    } catch (error) {
      console.error('Erro ao registrar ponto:', error);
      return serverErrorResponse('Erro ao registrar ponto');
    }
  });
}
