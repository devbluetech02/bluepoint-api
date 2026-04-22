import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor, isApiKeyAuth } from '@/lib/middleware';
import { aprovarSolicitacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { invalidateSolicitacaoCache, invalidateMarcacaoCache, invalidateLimitesHeEmpresasCache, invalidateLimitesHeDepartamentosCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { criarNotificacao, criarNotificacaoComPush } from '@/lib/notificacoes';
import { registrarOcorrenciaAtraso } from '@/lib/ocorrencias-externas';
import { calcularCustoHoraExtra, salvarCustoHoraExtra } from '@/lib/custoHorasExtrasService';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    try {
      const { id } = await params;
      const solicitacaoId = parseInt(id);

      if (isNaN(solicitacaoId)) {
        return notFoundResponse('Solicitação não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(aprovarSolicitacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { observacao } = validation.data;

      await client.query('BEGIN');

      // Verificar se solicitação existe e está pendente
      const solicitacaoResult = await client.query(
        `SELECT s.*, c.nome as colaborador_nome 
         FROM solicitacoes s
         JOIN people.colaboradores c ON s.colaborador_id = c.id
         WHERE s.id = $1`,
        [solicitacaoId]
      );

      if (solicitacaoResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFoundResponse('Solicitação não encontrada');
      }

      const solicitacao = solicitacaoResult.rows[0];

      if (solicitacao.status !== 'pendente') {
        await client.query('ROLLBACK');
        return errorResponse('Apenas solicitações pendentes podem ser aprovadas', 400);
      }

      // Verificar limites de HE por departamento/empresa para solicitações de hora extra
      if (solicitacao.tipo === 'hora_extra' && solicitacao.dados_adicionais && !isApiKeyAuth(user)) {
        const dados = solicitacao.dados_adicionais;
        if (dados.horaInicio && dados.horaFim) {
          const colabResult = await client.query(
            `SELECT c.empresa_id, c.departamento_id
             FROM people.colaboradores c WHERE c.id = $1`,
            [solicitacao.colaborador_id]
          );

          if (colabResult.rows.length > 0) {
            const { empresa_id: colabEmpresaId, departamento_id: colabDeptId } = colabResult.rows[0];

            // Determinar o papel do aprovador no departamento
            let papelAprovador: 'supervisor' | 'coordenador' | 'gerente' | 'admin' | null = null;

            if (user.tipo === 'admin') {
              papelAprovador = 'admin';
            } else if (colabDeptId && colabEmpresaId) {
              const liderancaResult = await client.query(
                `SELECT supervisor_ids, coordenador_ids, gerente_ids
                 FROM people.liderancas_departamento
                 WHERE empresa_id = $1 AND departamento_id = $2`,
                [colabEmpresaId, colabDeptId]
              );

              if (liderancaResult.rows.length > 0) {
                const lid = liderancaResult.rows[0];
                const supIds: number[] = lid.supervisor_ids || [];
                const coordIds: number[] = lid.coordenador_ids || [];
                const gerIds: number[] = lid.gerente_ids || [];

                if (supIds.includes(user.userId)) papelAprovador = 'supervisor';
                else if (coordIds.includes(user.userId)) papelAprovador = 'coordenador';
                else if (gerIds.includes(user.userId)) papelAprovador = 'gerente';
              }
            }

            // Se não encontrou papel nas lideranças e não é admin, permitir aprovação sem restrição de limite
            // (mantém comportamento anterior para gestores não configurados na tabela de lideranças)
            if (papelAprovador && papelAprovador !== 'admin' && colabDeptId && colabEmpresaId) {
              // Pré-calcular o custo desta solicitação
              const custoPreCalc = await calcularCustoHoraExtra(
                solicitacao.colaborador_id,
                dados.horaInicio,
                dados.horaFim
              );
              const custoSolicitacao = custoPreCalc?.custo_dia ?? 0;

              if (papelAprovador === 'supervisor' || papelAprovador === 'coordenador') {
                // Verificar limite do DEPARTAMENTO
                const limiteDeptResult = await client.query(
                  `SELECT limite_mensal FROM people.limites_he_departamentos
                   WHERE empresa_id = $1 AND departamento_id = $2`,
                  [colabEmpresaId, colabDeptId]
                );

                if (limiteDeptResult.rows.length > 0) {
                  const limiteDept = parseFloat(limiteDeptResult.rows[0].limite_mensal);

                  const acumDeptResult = await client.query(
                    `SELECT COALESCE(SUM((s.dados_adicionais->>'custo_aprovado')::numeric), 0) AS total
                     FROM people.solicitacoes s
                     JOIN people.colaboradores c ON s.colaborador_id = c.id
                     WHERE s.tipo = 'hora_extra'
                       AND s.status = 'aprovada'
                       AND c.departamento_id = $1
                       AND EXTRACT(MONTH FROM s.data_aprovacao) = EXTRACT(MONTH FROM CURRENT_DATE)
                       AND EXTRACT(YEAR FROM s.data_aprovacao) = EXTRACT(YEAR FROM CURRENT_DATE)`,
                    [colabDeptId]
                  );

                  const acumuladoDept = parseFloat(acumDeptResult.rows[0].total);

                  if ((acumuladoDept + custoSolicitacao) > limiteDept) {
                    await client.query('ROLLBACK');
                    return errorResponse(
                      `Limite do departamento atingido (R$ ${limiteDept.toFixed(2)}). ` +
                      `Acumulado no mês: R$ ${acumuladoDept.toFixed(2)}. ` +
                      `Custo desta aprovação: R$ ${custoSolicitacao.toFixed(2)}. ` +
                      `Apenas o Gerente pode aprovar.`,
                      403
                    );
                  }
                }
              } else if (papelAprovador === 'gerente') {
                // Gerente: verificar limite da EMPRESA
                const limiteEmpResult = await client.query(
                  `SELECT limite_mensal FROM people.limites_he_empresas
                   WHERE empresa_id = $1`,
                  [colabEmpresaId]
                );

                if (limiteEmpResult.rows.length > 0) {
                  const limiteEmpresa = parseFloat(limiteEmpResult.rows[0].limite_mensal);

                  const acumEmpResult = await client.query(
                    `SELECT COALESCE(SUM((s.dados_adicionais->>'custo_aprovado')::numeric), 0) AS total
                     FROM people.solicitacoes s
                     JOIN people.colaboradores c ON s.colaborador_id = c.id
                     WHERE s.tipo = 'hora_extra'
                       AND s.status = 'aprovada'
                       AND c.empresa_id = $1
                       AND EXTRACT(MONTH FROM s.data_aprovacao) = EXTRACT(MONTH FROM CURRENT_DATE)
                       AND EXTRACT(YEAR FROM s.data_aprovacao) = EXTRACT(YEAR FROM CURRENT_DATE)`,
                    [colabEmpresaId]
                  );

                  const acumuladoEmpresa = parseFloat(acumEmpResult.rows[0].total);

                  if ((acumuladoEmpresa + custoSolicitacao) > limiteEmpresa) {
                    await client.query('ROLLBACK');
                    return errorResponse(
                      `Limite da empresa atingido (R$ ${limiteEmpresa.toFixed(2)}). ` +
                      `Acumulado no mês: R$ ${acumuladoEmpresa.toFixed(2)}. ` +
                      `Custo desta aprovação: R$ ${custoSolicitacao.toFixed(2)}.`,
                      403
                    );
                  }
                }
              }
              // Admin: sem restrição de limite (não entra em nenhum if acima)
            }
          }
        }
      }

      // Se API Key, aprovador_id fica null (não existe na tabela de colaboradores)
      const aprovadorId = isApiKeyAuth(user) ? null : user.userId;
      const usuarioHistorico = isApiKeyAuth(user) ? solicitacao.colaborador_id : user.userId;

      // Calcular custos detalhados para HE
      let custoAprovado: number | null = null;
      let custoCompleto: Awaited<ReturnType<typeof calcularCustoHoraExtra>> = null;
      if (solicitacao.tipo === 'hora_extra' && solicitacao.dados_adicionais) {
        const dados = solicitacao.dados_adicionais;
        if (dados.horaInicio && dados.horaFim) {
          custoCompleto = await calcularCustoHoraExtra(
            solicitacao.colaborador_id,
            dados.horaInicio,
            dados.horaFim
          );
          if (custoCompleto) {
            custoAprovado = custoCompleto.custo_dia;
          }
        }
      }

      // Atualizar solicitação (com custo_aprovado no dados_adicionais se for HE)
      if (custoAprovado !== null) {
        await client.query(
          `UPDATE solicitacoes SET
            status = 'aprovada',
            aprovador_id = $1,
            data_aprovacao = NOW(),
            dados_adicionais = dados_adicionais || $3::jsonb,
            atualizado_em = NOW()
          WHERE id = $2`,
          [aprovadorId, solicitacaoId, JSON.stringify({ custo_aprovado: custoAprovado })]
        );
      } else {
        await client.query(
          `UPDATE solicitacoes SET
            status = 'aprovada',
            aprovador_id = $1,
            data_aprovacao = NOW(),
            atualizado_em = NOW()
          WHERE id = $2`,
          [aprovadorId, solicitacaoId]
        );
      }

      // Persistir custos detalhados em custo_horas_extras (upsert)
      if (custoCompleto) {
        try {
          const existente = await client.query(
            `SELECT id FROM people.custo_horas_extras WHERE solicitacao_id = $1 LIMIT 1`,
            [solicitacaoId]
          );
          if (existente.rows.length === 0) {
            await salvarCustoHoraExtra(
              solicitacaoId,
              solicitacao.colaborador_id,
              custoCompleto.cargo_id,
              custoCompleto.empresa_id,
              custoCompleto
            );
          }
        } catch (errCusto) {
          console.error('Erro ao persistir custos detalhados HE (não bloqueante):', errCusto);
        }
      }

      // Registrar histórico
      await client.query(
        `INSERT INTO solicitacoes_historico (solicitacao_id, status_anterior, status_novo, usuario_id, observacao)
         VALUES ($1, 'pendente', 'aprovada', $2, $3)`,
        [solicitacaoId, usuarioHistorico, observacao || 'Aprovado']
      );

      const acoes: string[] = [];

      // Férias aprovadas: registrar período para não gerar falta em relatório/espelho
      if (solicitacao.tipo === 'ferias') {
        const dataInicio = solicitacao.data_evento;
        const dataFim = solicitacao.data_evento_fim || solicitacao.data_evento;
        if (dataInicio) {
          await client.query(
            `INSERT INTO people.periodos_ferias (colaborador_id, data_inicio, data_fim, solicitacao_id)
             VALUES ($1, $2, $3, $4)`,
            [solicitacao.colaborador_id, dataInicio, dataFim, solicitacaoId]
          );
          acoes.push('Período de férias registrado para não gerar falta');
        }
      }

      // Executar ações automáticas baseadas no tipo
      
      if (solicitacao.tipo === 'ajuste_ponto' && solicitacao.dados_adicionais) {
        const dados = solicitacao.dados_adicionais;

        // Suporte ao formato novo (array de ajustes) e legado (ajuste único)
        const ajustes: { marcacaoId: number; dataHoraCorreta: string }[] = dados.ajustes
          ? dados.ajustes
          : (dados.marcacaoId && dados.dataHoraCorreta ? [{ marcacaoId: dados.marcacaoId, dataHoraCorreta: dados.dataHoraCorreta }] : []);

        for (const ajuste of ajustes) {
          const marcacaoAtual = await client.query(
            `SELECT data_hora FROM people.marcacoes WHERE id = $1`,
            [ajuste.marcacaoId]
          );

          const dataHoraOriginal = marcacaoAtual.rows[0]?.data_hora || null;

          await client.query(
            `UPDATE people.marcacoes SET 
              data_hora = $1,
              foi_ajustada = true,
              ajustada_por = $2,
              data_hora_original = $3,
              ajustada_em = NOW(),
              atualizado_em = NOW()
            WHERE id = $4`,
            [ajuste.dataHoraCorreta, user.userId, dataHoraOriginal, ajuste.marcacaoId]
          );
        }

        if (ajustes.length > 0) {
          acoes.push(`${ajustes.length} marcação(ões) ajustada(s) automaticamente`);
        }
      }

      // Contestação aprovada: relatório volta para pendente
      if (solicitacao.tipo === 'contestacao' && solicitacao.dados_adicionais) {
        const dados = solicitacao.dados_adicionais;
        if (dados.relatorioId) {
          await client.query(
            `UPDATE people.relatorios_mensais
             SET status = 'pendente',
                 assinado_em = NULL,
                 assinatura_imagem = NULL,
                 dispositivo = NULL,
                 localizacao_gps = NULL,
                 ip_address = NULL,
                 atualizado_em = NOW()
             WHERE id = $1`,
            [dados.relatorioId]
          );
          acoes.push(`Relatório ${dados.mes}/${dados.ano} reaberto para nova assinatura`);
        }
      }

      // Registrar ponto automaticamente quando aprovação de atraso
      if (solicitacao.tipo === 'atraso' && solicitacao.dados_adicionais) {
        const dados = solicitacao.dados_adicionais;
        const horarioRegistro = dados.horarioSolicitacao
          ? new Date(dados.horarioSolicitacao)
          : new Date(solicitacao.data_solicitacao);

        const marcacaoResult = await client.query(
          `INSERT INTO people.marcacoes (
            colaborador_id, empresa_id, data_hora, tipo,
            latitude, longitude, metodo, observacao
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id`,
          [
            solicitacao.colaborador_id,
            dados.empresaId || null,
            horarioRegistro,
            dados.tipoMarcacao || 'entrada',
            dados.latitude || null,
            dados.longitude || null,
            dados.metodo || 'web',
            `Ponto registrado via aprovação de atraso (${dados.atrasoMinutos}min). Aprovado por gestor.`,
          ]
        );

        const novaMarcacaoId = marcacaoResult.rows[0].id;

        // Registrar atraso como "não tolerado – aprovado por gestor" para relatórios
        const dataEvento = horarioRegistro.toISOString().split('T')[0];
        await client.query(
          `INSERT INTO people.atrasos_tolerados
             (colaborador_id, data, tipo_marcacao, horario_previsto, horario_real, atraso_minutos, tolerado, marcacao_id)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
          [
            solicitacao.colaborador_id,
            dataEvento,
            dados.tipoMarcacao || 'entrada',
            dados.horarioPrevisto || '00:00',
            horarioRegistro,
            dados.atrasoMinutos || 0,
            novaMarcacaoId,
          ]
        );

        acoes.push(`Ponto registrado automaticamente (${dados.tipoMarcacao || 'entrada'} às ${horarioRegistro.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })})`);

        // Notificar colaborador que o ponto foi registrado (DB + push)
        criarNotificacaoComPush({
          usuarioId: solicitacao.colaborador_id,
          tipo: 'solicitacao',
          titulo: 'Atraso aprovado — Ponto registrado',
          mensagem:
            `Seu gestor aprovou a solicitação de registro de ponto com atraso. ` +
            `Ponto registrado às ${horarioRegistro.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}.`,
          link: `/marcacoes`,
          metadados: {
            acao: 'atraso_aprovado',
            solicitacaoId,
            marcacaoId: novaMarcacaoId,
          },
          pushSeveridade: 'info',
        }).catch((err) => console.error('[Notificação] Erro ao notificar colaborador:', err));

        // Registrar ocorrência de atraso no Portal do Colaborador (async, não bloqueia)
        registrarOcorrenciaAtraso({
          colaboradorNome: solicitacao.colaborador_nome,
          dataOcorrencia: horarioRegistro.toISOString().split('T')[0],
          minutosAtraso: dados.atrasoMinutos || 0,
          marcacaoId: novaMarcacaoId,
        }).catch((err) => console.error('[Ocorrência] Erro ao registrar atraso no portal (não bloqueante):', err));
      }

      await client.query('COMMIT');

      // Notificar o solicitante para todos os tipos (exceto 'atraso' que já notifica acima)
      if (solicitacao.tipo !== 'atraso') {
        const titulosAprovacao: Record<string, string> = {
          ajuste_ponto: 'Ajuste de ponto aprovado',
          hora_extra: 'Hora extra aprovada',
          ferias: 'Férias aprovadas',
          contestacao: 'Contestação aprovada',
          atestado: 'Atestado aceito',
        };
        const nomeTipo: Record<string, string> = {
          ajuste_ponto: 'ajuste de ponto',
          hora_extra: 'hora extra',
          ferias: 'férias',
          contestacao: 'contestação de relatório',
          atestado: 'atestado médico',
        };
        const titulo = titulosAprovacao[solicitacao.tipo] ?? 'Solicitação aprovada';
        const tipo = nomeTipo[solicitacao.tipo] ?? solicitacao.tipo;
        const obs = observacao ? ` Obs: "${observacao}".` : '';
        criarNotificacaoComPush({
          usuarioId: solicitacao.colaborador_id,
          tipo: 'solicitacao',
          titulo,
          mensagem: `Sua solicitação de ${tipo} foi aprovada.${obs}`,
          link: `/solicitacoes/${solicitacaoId}`,
          metadados: { acao: 'solicitacao_aprovada', solicitacaoId, tipo: solicitacao.tipo },
          pushSeveridade: 'info',
        }).catch((err) => console.error('[Notificação] Erro ao notificar aprovação:', err));
      }

      // Invalidar cache de solicitações
      await invalidateSolicitacaoCache(solicitacaoId, solicitacao.colaborador_id);
      
      if (solicitacao.tipo === 'ajuste_ponto' || solicitacao.tipo === 'atraso') {
        await invalidateMarcacaoCache(solicitacao.colaborador_id);
      }

      if (solicitacao.tipo === 'atraso') {
        await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);
      }

      if (solicitacao.tipo === 'hora_extra') {
        await invalidateLimitesHeEmpresasCache();
        await invalidateLimitesHeDepartamentosCache();
      }

      // Registrar auditoria
      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'aprovar',
        modulo: 'solicitacoes',
        descricao: `Solicitação aprovada: ${solicitacao.tipo} de ${solicitacao.colaborador_nome}`,
        colaboradorId: solicitacao.colaborador_id,
        colaboradorNome: solicitacao.colaborador_nome,
        entidadeId: solicitacaoId,
        entidadeTipo: 'solicitacao',
        dadosNovos: { solicitacaoId, status: 'aprovada' },
      }));

      return successResponse({
        id: solicitacaoId,
        status: 'aprovada',
        mensagem: 'Solicitação aprovada com sucesso',
        acoes,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao aprovar solicitação:', error);
      return serverErrorResponse('Erro ao aprovar solicitação');
    } finally {
      client.release();
    }
  });
}
