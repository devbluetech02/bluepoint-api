import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse, successResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { validateBody } from '@/lib/validation';
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
import { verificarEAplicarToleranciaHoraExtra, verificarEAplicarToleranciaHoraExtraEntrada } from '@/lib/hora-extra-tolerancia';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { z } from 'zod';

/**
 * Schema de validação para registro de ponto individual.
 * O colaborador já está autenticado via JWT - não precisa de reconhecimento facial
 * nem de código de dispositivo.
 */
const registrarPontoIndividualSchema = z.object({
  foto: z.string().min(100, 'Foto é obrigatória').optional(),
  localizacao: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),
});

/**
 * POST /api/v1/registrar-ponto-individual
 *
 * Endpoint para o app INDIVIDUAL do colaborador registrar ponto.
 * O colaborador já está logado (autenticado via JWT), portanto:
 * - NÃO precisa de reconhecimento facial (identidade já confirmada pelo login)
 * - NÃO precisa de código de dispositivo (não é o totem compartilhado)
 * - Armazena a foto do registro (para auditoria/comprovação)
 * - Usa os dados do JWT para identificar o colaborador
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();

      const validation = registrarPontoIndividualSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        for (const issue of validation.error.issues) {
          const field = issue.path.join('.') || 'foto';
          if (!errors[field]) errors[field] = [];
          errors[field].push(issue.message);
        }
        return validationErrorResponse(errors);
      }

      const data = validation.data;
      const agora = new Date();

      // Buscar colaborador pelo userId do JWT
      const colaboradorResult = await query(
        `SELECT c.id, c.nome, c.jornada_id, c.empresa_id,
                c.permite_ponto_mobile
         FROM people.colaboradores c
         WHERE c.id = $1 AND c.status = 'ativo'`,
        [user.userId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado ou inativo', 404);
      }

      const colaborador = colaboradorResult.rows[0];

      // Verificar permissão de ponto pelo celular
      if (!colaborador.permite_ponto_mobile) {
        return errorResponse('Este colaborador não tem permissão para marcar ponto pelo celular', 403);
      }

      // Buscar jornada do dia
      const jornada = await obterJornadaDoDia(user.userId);

      if (!jornada) {
        return errorResponse('Colaborador não possui jornada configurada ou hoje é folga', 400);
      }

      if (jornada.folga) {
        return errorResponse('Hoje é dia de folga na jornada do colaborador', 400);
      }

      // Determinar proximo evento
      const evento = await determinarProximoEvento(user.userId, jornada);

      // Validar sequencia de marcacoes
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

      // Buscar parametros globais de tolerancia
      const parametros = await obterParametrosTolerancia();

      // Analisar atraso (so relevante para entrada/retorno)
      const analise = await analisarAtraso(
        user.userId,
        parametros,
        evento.tipoMarcacao,
        evento.horarioPrevisto,
        evento.periodoIndex,
        agora
      );

      // Se atrasado e FORA da tolerancia -> nao registra, retorna pedido de aprovacao
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
          const caminho = `marcacoes/${user.userId}/${dataFormatada}/${timestamp}_${evento.tipoMarcacao}.${extensao}`;

          fotoUrl = await uploadArquivo(caminho, buffer, contentType);
        } catch (uploadError) {
          console.warn('Erro ao fazer upload da foto (não bloqueante):', uploadError);
        }
      }

      // Registrar ponto
      const result = await query(
        `INSERT INTO people.marcacoes (
          colaborador_id, empresa_id, data_hora, tipo, latitude, longitude, metodo, foto_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, data_hora`,
        [
          user.userId,
          colaborador.empresa_id || null,
          agora,
          evento.tipoMarcacao,
          data.localizacao?.latitude || null,
          data.localizacao?.longitude || null,
          'app',
          fotoUrl,
        ]
      );

      const marcacao = result.rows[0];
      embedTableRowAfterInsert('marcacoes', marcacao.id).catch(() => {});

      // Se houve atraso tolerado, registrar no controle interno
      if (analise.atrasado && analise.registrarNormalmente && analise.atrasoMinutos > 0) {
        try {
          await registrarAtrasoTolerado(
            user.userId,
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

      // Tolerancia hora extra (entrada antecipada)
      let toleranciaHoraExtra = null;
      if (evento.tipoMarcacao === 'entrada') {
        try {
          const toleranciaResult = await verificarEAplicarToleranciaHoraExtraEntrada(
            user.userId,
            colaborador.nome,
            user.userId,
            getClientIp(request),
            getUserAgent(request)
          );
          if (toleranciaResult) {
            toleranciaHoraExtra = {
              consumiuTolerancia: toleranciaResult.consumiuTolerancia,
              solicitacaoId: toleranciaResult.solicitacaoId || null,
              mensagem: toleranciaResult.mensagem,
            };
          }
        } catch (toleranciaError) {
          console.error('Erro ao processar tolerância entrada (não crítico):', toleranciaError);
        }
      }

      // Tolerancia hora extra (saida tardia)
      if (evento.tipoMarcacao === 'saida') {
        try {
          const toleranciaResult = await verificarEAplicarToleranciaHoraExtra(
            user.userId,
            colaborador.nome,
            user.userId,
            getClientIp(request),
            getUserAgent(request)
          );
          if (toleranciaResult) {
            toleranciaHoraExtra = {
              consumiuTolerancia: toleranciaResult.consumiuTolerancia,
              solicitacaoId: toleranciaResult.solicitacaoId || null,
              mensagem: toleranciaResult.mensagem,
            };
          }
        } catch (toleranciaError) {
          console.error('Erro ao processar tolerância saída (não crítico):', toleranciaError);
        }
      }

      // Invalidar cache
      await invalidateMarcacaoCache(user.userId);
      await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);

      // Determinar status e proxima marcacao
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
        descricao: `${tipoLabel[evento.tipoMarcacao] || 'Ponto registrado'} (app individual): ${colaborador.nome}${analise.atrasado ? ` (atraso tolerado: ${analise.atrasoMinutos}min)` : ''}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          marcacaoId: marcacao.id,
          colaboradorId: user.userId,
          tipo: evento.tipoMarcacao,
          status,
          metodo: 'app',
          fotoUrl,
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
        fotoUrl,
        proximaMarcacao: proximaMarcacaoMap[evento.tipoMarcacao] || null,
        ...(toleranciaHoraExtra && { toleranciaHoraExtra }),
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
      console.error('Erro ao registrar ponto individual:', error);
      return serverErrorResponse('Erro ao registrar ponto');
    }
  });
}
