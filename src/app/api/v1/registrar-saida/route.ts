import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarPontoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { minutesToHHMM } from '@/lib/utils';
import { invalidateMarcacaoCache } from '@/lib/cache';
import { uploadArquivo } from '@/lib/storage';
import { verificarEAplicarToleranciaHoraExtra } from '@/lib/hora-extra-tolerancia';

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
                j.tolerancia_saida
         FROM bluepoint.bt_colaboradores c
         LEFT JOIN bt_jornadas j ON c.jornada_id = j.id
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

      // Verificar marcações de hoje para determinar tipo automático (almoco ou saida)
      const marcacoesHojeResult = await query(
        `SELECT id, tipo, data_hora FROM bluepoint.bt_marcacoes
         WHERE colaborador_id = $1 
         AND DATE(data_hora) = CURRENT_DATE
         ORDER BY data_hora ASC`,
        [data.colaboradorId]
      );

      const marcacoesHoje = marcacoesHojeResult.rows;
      const ultimaMarcacaoRow = marcacoesHoje.length > 0 ? marcacoesHoje[marcacoesHoje.length - 1] : null;

      // Não permitir saída/almoço se não há entrada ou se a última foi saída/almoço
      if (!ultimaMarcacaoRow || ultimaMarcacaoRow.tipo === 'saida' || ultimaMarcacaoRow.tipo === 'almoco') {
        return errorResponse('Registre a entrada primeiro.', 400);
      }

      // Detectar automaticamente: se a última marcação foi 'entrada' e não houve almoco, é almoco; senão, é saida
      const jaTeveAlmoco = marcacoesHoje.some((m) => m.tipo === 'almoco');
      const tipoMarcacao = (!jaTeveAlmoco && ultimaMarcacaoRow.tipo === 'entrada') ? 'almoco' : 'saida';

      // Buscar a última entrada/retorno para calcular tempo trabalhado
      const entrada = ultimaMarcacaoRow;

      // Buscar horário previsto
      const diaSemana = agora.getDay();
      let status = 'no_horario';

      if (colaborador.jornada_id) {
        const horarioResult = await query(
          `SELECT saida FROM bluepoint.bt_jornada_horarios
           WHERE jornada_id = $1 AND dia_semana = $2`,
          [colaborador.jornada_id, diaSemana]
        );

        if (horarioResult.rows.length > 0) {
          const saidaPrevista = horarioResult.rows[0].saida;
          const horaAtual = agora.toTimeString().substring(0, 5);
          
          const minutosAtual = parseInt(horaAtual.split(':')[0]) * 60 + parseInt(horaAtual.split(':')[1]);
          const minutosPrevisto = parseInt(saidaPrevista.split(':')[0]) * 60 + parseInt(saidaPrevista.split(':')[1]);
          const diferenca = minutosPrevisto - minutosAtual;
          
          const tolerancia = colaborador.tolerancia_saida || 10;

          if (diferenca > tolerancia) {
            status = 'saida_antecipada';
          } else if (diferenca < -tolerancia) {
            status = 'hora_extra';
          }
        }
      }

      // Calcular tempo trabalhado
      const entradaDate = new Date(entrada.data_hora);
      const diffMs = agora.getTime() - entradaDate.getTime();
      const diffMinutos = Math.floor(diffMs / 60000);
      const horasTrabalhadas = minutesToHHMM(diffMinutos);

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

      // Inserir marcação (almoco ou saida)
      const result = await query(
        `INSERT INTO bluepoint.bt_marcacoes (
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

      // =====================================================
      // LÓGICA AUTOMÁTICA DE TOLERÂNCIA DE HORA EXTRA
      // Usa módulo compartilhado (lib/hora-extra-tolerancia)
      // =====================================================
      let toleranciaInfo: { consumiuTolerancia: boolean; solicitacaoId?: number; mensagem: string } | null = null;

      if (tipoMarcacao === 'saida') {
        const resultado = await verificarEAplicarToleranciaHoraExtra(
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
      const descricaoAuditoria = tipoMarcacao === 'almoco'
        ? `Saída para almoço registrada: ${colaborador.nome}`
        : `Saída registrada: ${colaborador.nome}`;

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
        proximaMarcacao: tipoMarcacao === 'almoco' ? 'retorno' : undefined,
        status,
        resumoDia: {
          horasTrabalhadas,
          horasExtras: '00:00',
          saldo: horasTrabalhadas,
        },
        ...(toleranciaInfo && {
          toleranciaHoraExtra: {
            consumiuTolerancia: toleranciaInfo.consumiuTolerancia,
            solicitacaoId: toleranciaInfo.solicitacaoId || null,
            mensagem: toleranciaInfo.mensagem,
          },
        }),
      });
    } catch (error) {
      console.error('Erro ao registrar saída:', error);
      return serverErrorResponse('Erro ao registrar saída');
    }
  });
}
