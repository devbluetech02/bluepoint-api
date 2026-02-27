import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { verificarFaceSchema, validateBody } from '@/lib/validation';
import { verificarEAplicarToleranciaHoraExtra, verificarEAplicarToleranciaHoraExtraEntrada } from '@/lib/hora-extra-tolerancia';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(verificarFaceSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Em produção, aqui seria feita a comparação real com um serviço de reconhecimento facial
      // Por enquanto, retornamos uma simulação

      // Buscar colaboradores com biometria cadastrada
      const biometriaResult = await query(
        `SELECT b.colaborador_id, b.qualidade, c.nome, c.email
         FROM bt_biometria_facial b
         JOIN bluepoint.bt_colaboradores c ON b.colaborador_id = c.id
         WHERE c.status = 'ativo'
         LIMIT 1` // Simulação - em produção compararia o encoding
      );

      if (biometriaResult.rows.length === 0) {
        return successResponse({
          reconhecido: false,
          colaborador: null,
          confianca: 0,
          marcacaoRegistrada: false,
          marcacao: null,
        });
      }

      // Simulação de reconhecimento
      const colaborador = biometriaResult.rows[0];
      const confianca = 0.92; // Simulado

      // Registrar marcação automaticamente se reconhecido
      let marcacao = null;
      if (confianca >= 0.85) {
        // Buscar todas as marcações do dia para detecção automática de tipo
        const marcacoesHoje = await query(
          `SELECT tipo FROM bluepoint.bt_marcacoes
           WHERE colaborador_id = $1 AND DATE(data_hora) = CURRENT_DATE
           ORDER BY data_hora ASC`,
          [colaborador.colaborador_id]
        );

        // Detectar tipo automaticamente: entrada → almoco → retorno → saida
        let tipo: 'entrada' | 'saida' | 'almoco' | 'retorno' = 'entrada';
        if (marcacoesHoje.rows.length > 0) {
          const marcacoes = marcacoesHoje.rows;
          const ultimoTipo = marcacoes[marcacoes.length - 1].tipo;
          const jaTeveAlmoco = marcacoes.some((m) => m.tipo === 'almoco');
          const jaTeveRetorno = marcacoes.some((m) => m.tipo === 'retorno');

          if (ultimoTipo === 'entrada' && !jaTeveAlmoco) {
            tipo = 'almoco';
          } else if (ultimoTipo === 'almoco' && !jaTeveRetorno) {
            tipo = 'retorno';
          } else if (ultimoTipo === 'retorno') {
            tipo = 'saida';
          } else if (ultimoTipo === 'saida') {
            tipo = 'entrada';
          } else {
            tipo = (ultimoTipo === 'entrada' || ultimoTipo === 'retorno') ? 'saida' : 'entrada';
          }
        }

        const marcacaoResult = await query(
          `INSERT INTO bluepoint.bt_marcacoes (colaborador_id, data_hora, tipo, latitude, longitude, metodo)
           VALUES ($1, NOW(), $2, $3, $4, 'biometria')
           RETURNING id, data_hora, tipo`,
          [
            colaborador.colaborador_id,
            tipo,
            data.localizacao?.latitude || null,
            data.localizacao?.longitude || null,
          ]
        );

        marcacao = marcacaoResult.rows[0];

        // Lógica de tolerância de hora extra (entrada antecipada)
        if (tipo === 'entrada') {
          try {
            const toleranciaResult = await verificarEAplicarToleranciaHoraExtraEntrada(
              colaborador.colaborador_id,
              colaborador.nome,
              colaborador.colaborador_id,
              req.headers.get('x-forwarded-for') || 'unknown',
              req.headers.get('user-agent') || 'unknown'
            );

            if (toleranciaResult) {
              marcacao.toleranciaHoraExtra = {
                consumiuTolerancia: toleranciaResult.consumiuTolerancia,
                solicitacaoId: toleranciaResult.solicitacaoId || null,
                mensagem: toleranciaResult.mensagem,
              };
            }
          } catch (toleranciaError) {
            console.error('Erro ao processar tolerância entrada (não crítico):', toleranciaError);
          }
        }

        // Lógica de tolerância de hora extra (saída tardia)
        if (tipo === 'saida') {
          try {
            const toleranciaResult = await verificarEAplicarToleranciaHoraExtra(
              colaborador.colaborador_id,
              colaborador.nome,
              colaborador.colaborador_id,
              req.headers.get('x-forwarded-for') || 'unknown',
              req.headers.get('user-agent') || 'unknown'
            );

            if (toleranciaResult) {
              marcacao.toleranciaHoraExtra = {
                consumiuTolerancia: toleranciaResult.consumiuTolerancia,
                solicitacaoId: toleranciaResult.solicitacaoId || null,
                mensagem: toleranciaResult.mensagem,
              };
            }
          } catch (toleranciaError) {
            console.error('Erro ao processar tolerância (não crítico):', toleranciaError);
          }
        }
      }

      return successResponse({
        reconhecido: confianca >= 0.85,
        colaborador: {
          id: colaborador.colaborador_id,
          nome: colaborador.nome,
          email: colaborador.email,
        },
        confianca,
        marcacaoRegistrada: marcacao !== null,
        marcacao,
      });
    } catch (error) {
      console.error('Erro ao verificar face:', error);
      return serverErrorResponse('Erro ao verificar biometria');
    }
  });
}
