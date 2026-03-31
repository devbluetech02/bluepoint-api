import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarPontoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateMarcacaoCache } from '@/lib/cache';
import { uploadArquivo } from '@/lib/storage';
import { registrarOcorrenciaAtraso } from '@/lib/ocorrencias-externas';
import { verificarEAplicarToleranciaHoraExtraEntrada } from '@/lib/hora-extra-tolerancia';
import { notificarAtrasoParaJustificar } from '@/lib/notificacoes';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(registrarPontoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;
      const agora = new Date();

      // Verificar se colaborador existe e está ativo
      const colaboradorResult = await query(
        `SELECT c.id, c.nome, c.jornada_id, c.empresa_id, 
                c.permite_ponto_mobile, c.permite_ponto_qualquer_empresa,
                j.tolerancia_entrada
         FROM people.colaboradores c
         LEFT JOIN jornadas j ON c.jornada_id = j.id
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

      // Verificar permissão de ponto em qualquer empresa
      if (data.empresaId && colaborador.empresa_id && data.empresaId !== colaborador.empresa_id && !colaborador.permite_ponto_qualquer_empresa) {
        return errorResponse('Este colaborador não tem permissão para marcar ponto em outra empresa', 403);
      }

      // Verificar marcações de hoje para determinar tipo automático (entrada ou retorno)
      const marcacoesHojeResult = await query(
        `SELECT id, tipo FROM people.marcacoes
         WHERE colaborador_id = $1 
         AND DATE(data_hora) = CURRENT_DATE
         ORDER BY data_hora ASC`,
        [data.colaboradorId]
      );

      const marcacoesHoje = marcacoesHojeResult.rows;
      const ultimaMarcacao = marcacoesHoje.length > 0 ? marcacoesHoje[marcacoesHoje.length - 1] : null;

      // Não permitir entrada/retorno se a última marcação foi entrada ou retorno (precisa registrar saída/almoço primeiro)
      if (ultimaMarcacao && (ultimaMarcacao.tipo === 'entrada' || ultimaMarcacao.tipo === 'retorno')) {
        return errorResponse('Já existe uma entrada registrada. Registre a saída primeiro.', 400);
      }

      // Detectar automaticamente: se já houve almoco hoje, é retorno; senão, é entrada
      const jaTeveAlmoco = marcacoesHoje.some((m) => m.tipo === 'almoco');
      const tipoMarcacao = jaTeveAlmoco ? 'retorno' : 'entrada';

      // Buscar horário previsto da jornada
      const diaSemana = agora.getDay();
      let status = 'no_horario';
      let divergencia = { minutos: 0, mensagem: '' };

      if (colaborador.jornada_id) {
        // Buscar horário: por dia_semana fixo OU por dias_semana JSONB (jornada circular)
        const horarioResult = await query(
          `SELECT periodos, folga FROM people.jornada_horarios
           WHERE jornada_id = $1 
             AND folga = false
             AND (dia_semana = $2 OR dias_semana @> $3::jsonb)
           LIMIT 1`,
          [colaborador.jornada_id, diaSemana, JSON.stringify([diaSemana])]
        );

        if (horarioResult.rows.length > 0) {
          const periodos = horarioResult.rows[0].periodos;

          // Extrair entrada do primeiro período (ex: [{"entrada": "08:00", "saida": "12:00"}, ...])
          const primeiroEntrada = Array.isArray(periodos) && periodos.length > 0
            ? periodos[0].entrada
            : null;

          if (primeiroEntrada) {
            const entradaPrevista = primeiroEntrada.substring(0, 5);
            const horaAtual = agora.toTimeString().substring(0, 5);
            
            const minutosAtual = parseInt(horaAtual.split(':')[0]) * 60 + parseInt(horaAtual.split(':')[1]);
            const minutosPrevisto = parseInt(entradaPrevista.split(':')[0]) * 60 + parseInt(entradaPrevista.split(':')[1]);
            const diferenca = minutosAtual - minutosPrevisto;
            
            const tolerancia = colaborador.tolerancia_entrada || 10;

            if (diferenca > tolerancia) {
              status = 'atrasado';
              divergencia = {
                minutos: diferenca,
                mensagem: `Atraso de ${diferenca} minutos`,
              };
            } else if (diferenca < -tolerancia) {
              status = 'hora_extra';
              divergencia = {
                minutos: Math.abs(diferenca),
                mensagem: `Entrada antecipada de ${Math.abs(diferenca)} minutos`,
              };
            }
          }
        }
      }

      // Upload da foto para MinIO (se enviada)
      let fotoUrl: string | null = null;
      if (data.foto) {
        try {
          const base64Data = data.foto.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');
          
          // Detectar tipo de imagem
          let extensao = 'jpg';
          let contentType = 'image/jpeg';
          if (data.foto.startsWith('data:image/png')) {
            extensao = 'png';
            contentType = 'image/png';
          }
          
          // Gerar caminho: marcacoes/{colaboradorId}/{data}/{timestamp}.{ext}
          const dataFormatada = agora.toISOString().split('T')[0];
          const timestamp = agora.getTime();
          const caminho = `marcacoes/${data.colaboradorId}/${dataFormatada}/${timestamp}_${tipoMarcacao}.${extensao}`;
          
          fotoUrl = await uploadArquivo(caminho, buffer, contentType);
        } catch (uploadError) {
          console.warn('Erro ao fazer upload da foto:', uploadError);
          // Continua sem a foto
        }
      }

      // Inserir marcação (entrada ou retorno)
      const result = await query(
        `INSERT INTO people.marcacoes (
          colaborador_id, empresa_id, data_hora, tipo, latitude, longitude, metodo, foto_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, data_hora`,
        [
          data.colaboradorId,
          data.empresaId || null,
          agora,
          tipoMarcacao,
          data.localizacao?.latitude || null,
          data.localizacao?.longitude || null,
          data.metodo,
          fotoUrl,
        ]
      );

      const marcacao = result.rows[0];

      // Invalidar cache de marcações
      await invalidateMarcacaoCache(data.colaboradorId);

      // Registrar ocorrência no Portal e notificar colaborador (async, não bloqueia)
      if (status === 'atrasado') {
        registrarOcorrenciaAtraso({
          colaboradorNome: colaborador.nome,
          dataOcorrencia: agora.toISOString().split('T')[0],
          minutosAtraso: divergencia.minutos,
          marcacaoId: marcacao.id,
        }).catch((err) => {
          console.error('[Ocorrência] Erro ao registrar atraso (async):', err);
        });

        notificarAtrasoParaJustificar({
          colaboradorId: data.colaboradorId,
          marcacaoId: marcacao.id,
          minutosAtraso: divergencia.minutos,
          dataOcorrencia: agora.toISOString().split('T')[0],
        }).catch((err) => {
          console.error('[Notificação] Erro ao notificar atraso:', err);
        });
      }

      // Lógica automática de tolerância de hora extra (entrada antecipada)
      let toleranciaInfo: { consumiuTolerancia: boolean; solicitacaoId?: number; mensagem: string } | null = null;

      if (tipoMarcacao === 'entrada') {
        const resultado = await verificarEAplicarToleranciaHoraExtraEntrada(
          data.colaboradorId,
          colaborador.nome,
          user.userId,
          getClientIp(request),
          getUserAgent(request)
        );

        if (resultado) {
          toleranciaInfo = {
            consumiuTolerancia: resultado.consumiuTolerancia,
            solicitacaoId: resultado.solicitacaoId,
            mensagem: resultado.mensagem,
          };
        }
      }

      // Registrar auditoria
      const descricaoAuditoria = tipoMarcacao === 'retorno' 
        ? `Retorno do almoço registrado: ${colaborador.nome}`
        : `Entrada registrada: ${colaborador.nome}`;

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'marcacoes',
        descricao: descricaoAuditoria,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: {
          marcacaoId: marcacao.id,
          colaboradorId: data.colaboradorId,
          tipo: tipoMarcacao,
          status,
        },
      });

      return createdResponse({
        id: marcacao.id,
        dataHora: marcacao.data_hora,
        tipo: tipoMarcacao,
        status,
        divergencia,
        proximaMarcacao: tipoMarcacao === 'retorno' ? 'saida' : 'almoco',
        ...(toleranciaInfo && {
          toleranciaHoraExtra: {
            consumiuTolerancia: toleranciaInfo.consumiuTolerancia,
            solicitacaoId: toleranciaInfo.solicitacaoId || null,
            mensagem: toleranciaInfo.mensagem,
          },
        }),
      });
    } catch (error) {
      console.error('Erro ao registrar entrada:', error);
      return serverErrorResponse('Erro ao registrar entrada');
    }
  });
}
