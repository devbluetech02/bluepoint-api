import { query } from '@/lib/db';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { enviarPushParaColaborador, type PushSeveridade } from '@/lib/push-colaborador';

/**
 * Retorna os IDs de colaboradores ativos que têm o código de permissão
 * efetivamente concedido — considerando:
 *   - permissão concedida pelo NÍVEL do cargo (nivel_acesso_permissoes)
 *   - mais overrides do cargo com concedido=true
 *   - menos overrides do cargo com concedido=false
 *   - mais god mode (userId=1)
 *
 * Usado pra disparar notificações respeitando as permissões `notificacao:*`
 * em vez de broadcast cego pra `tipo IN ('admin','gestor')`.
 */
export async function obterColaboradoresComPermissao(
  codigoPermissao: string,
): Promise<number[]> {
  const r = await query<{ id: number }>(
    `WITH cargos_com_perm AS (
       -- Cargos cujo NÍVEL concede a permissão e SEM override-removida.
       SELECT DISTINCT cg.id
         FROM people.cargos cg
         JOIN people.nivel_acesso_permissoes nap
           ON nap.nivel_id = cg.nivel_acesso_id AND nap.concedido = true
         JOIN people.permissoes p ON p.id = nap.permissao_id
        WHERE p.codigo = $1
          AND NOT EXISTS (
            SELECT 1 FROM people.cargo_permissoes_override o
            JOIN people.permissoes p2 ON p2.id = o.permissao_id
            WHERE o.cargo_id = cg.id
              AND p2.codigo = $1
              AND o.concedido = false
          )
       UNION
       -- Cargos com override ADICIONA (concedido=true) — extra.
       SELECT DISTINCT cg.id
         FROM people.cargos cg
         JOIN people.cargo_permissoes_override o ON o.cargo_id = cg.id
         JOIN people.permissoes p ON p.id = o.permissao_id
        WHERE p.codigo = $1 AND o.concedido = true
     )
     SELECT id
       FROM people.colaboradores
      WHERE status = 'ativo'
        AND cargo_id IN (SELECT id FROM cargos_com_perm)
     UNION
     -- God mode: super admin (userId=1) sempre na lista, ativo ou não
     -- (filtramos status no caller se precisar).
     SELECT id FROM people.colaboradores WHERE id = 1 AND status = 'ativo'`,
    [codigoPermissao],
  );
  return r.rows.map((row) => row.id);
}

type TipoNotificacao = 'sistema' | 'solicitacao' | 'marcacao' | 'alerta' | 'lembrete';

interface CriarNotificacaoParams {
  usuarioId: number;
  tipo: TipoNotificacao;
  titulo: string;
  mensagem: string;
  link?: string;
  metadados?: Record<string, unknown>;
}

/**
 * Cria uma notificação na tabela notificacoes.
 * Retorna o ID da notificação criada ou null em caso de falha.
 */
export async function criarNotificacao(params: CriarNotificacaoParams): Promise<number | null> {
  try {
    const result = await query(
      `INSERT INTO people.notificacoes (usuario_id, tipo, titulo, mensagem, link, metadados)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        params.usuarioId,
        params.tipo,
        params.titulo,
        params.mensagem,
        params.link || null,
        params.metadados ? JSON.stringify(params.metadados) : null,
      ]
    );
    const id = result.rows[0]?.id ?? null;
    if (id != null) {
      embedTableRowAfterInsert('notificacoes', id).catch(() => {});
    }
    return id;
  } catch (error) {
    console.error('[Notificação] Erro ao criar notificação:', error);
    return null;
  }
}

/**
 * Cria notificação no banco E envia push OneSignal simultaneamente.
 * O push é fire-and-forget — falha não impede a criação da notificação no banco.
 *
 * Esta é a função preferida para notificar colaboradores sobre eventos no app.
 * Escalabilidade: futuramente consulta people.parametros_notificacoes para
 * respeitar as preferências do usuário antes de enviar o push.
 */
export async function criarNotificacaoComPush(
  params: CriarNotificacaoParams & { pushSeveridade?: PushSeveridade; fotoUrl?: string }
): Promise<number | null> {
  const id = await criarNotificacao(params);

  enviarPushParaColaborador(params.usuarioId, {
    titulo: params.titulo,
    mensagem: params.mensagem,
    severidade: params.pushSeveridade ?? 'info',
    data: {
      ...params.metadados,
      notificacaoId: id,
    },
    url: params.link,
    fotoUrl: params.fotoUrl,
  }).catch((err) => console.error('[Push] Erro ao enviar push para colaborador:', err));

  return id;
}

/**
 * Cria notificação de atraso para o colaborador justificar.
 * Os metadados incluem tudo que o app mobile precisa para montar a tela de justificativa.
 */
export async function notificarAtrasoParaJustificar(params: {
  colaboradorId: number;
  marcacaoId: number;
  minutosAtraso: number;
  dataOcorrencia: string;
}): Promise<number | null> {
  return criarNotificacaoComPush({
    usuarioId: params.colaboradorId,
    tipo: 'alerta',
    titulo: 'Atraso registrado — Justifique',
    mensagem:
      `Você registrou entrada com ${params.minutosAtraso} minutos de atraso em ${params.dataOcorrencia}. ` +
      `Uma ocorrência foi gerada automaticamente. Toque aqui para enviar sua justificativa.`,
    link: '/justificar-atraso',
    metadados: {
      acao: 'justificar_atraso',
      marcacaoId: params.marcacaoId,
      minutosAtraso: params.minutosAtraso,
      dataOcorrencia: params.dataOcorrencia,
    },
    pushSeveridade: 'atencao',
  });
}

/**
 * Notifica os gestores responsáveis sobre o atraso de um colaborador da
 * sua equipe. Lideranças do departamento + colaboradores com permissão
 * `notificacao:atraso_equipe` recebem push. Fire-and-forget — falhas não
 * derrubam o registro de entrada.
 */
export async function notificarGestoresSobreAtraso(params: {
  colaboradorId: number;
  marcacaoId: number;
  minutosAtraso: number;
  dataOcorrencia: string;
}): Promise<void> {
  const { colaboradorId, marcacaoId, minutosAtraso, dataOcorrencia } = params;

  const colabResult = await query<{
    nome: string;
    empresa_id: number | null;
    departamento_id: number | null;
  }>(
    `SELECT nome, empresa_id, departamento_id
       FROM people.colaboradores
      WHERE id = $1`,
    [colaboradorId],
  );
  if (colabResult.rows.length === 0) return;
  const { nome: colabNome, empresa_id, departamento_id } = colabResult.rows[0];

  const ids = new Set<number>();

  if (empresa_id && departamento_id) {
    const liderResult = await query<{
      supervisor_ids: number[] | null;
      coordenador_ids: number[] | null;
      gerente_ids: number[] | null;
    }>(
      `SELECT supervisor_ids, coordenador_ids, gerente_ids
         FROM people.liderancas_departamento
        WHERE empresa_id = $1 AND departamento_id = $2`,
      [empresa_id, departamento_id],
    );
    if (liderResult.rows.length > 0) {
      const l = liderResult.rows[0];
      for (const id of [
        ...(l.supervisor_ids ?? []),
        ...(l.coordenador_ids ?? []),
        ...(l.gerente_ids ?? []),
      ]) {
        ids.add(id);
      }
    }
  }

  const comPermissao = await obterColaboradoresComPermissao('notificacao:atraso_equipe');
  for (const id of comPermissao) ids.add(id);

  ids.delete(colaboradorId);
  if (ids.size === 0) return;

  const titulo = 'Atraso na equipe';
  const mensagem = `${colabNome} registrou entrada com ${minutosAtraso} min de atraso em ${dataOcorrencia}.`;

  for (const gestorId of ids) {
    criarNotificacaoComPush({
      usuarioId: gestorId,
      tipo: 'alerta',
      titulo,
      mensagem,
      link: `/colaboradores/${colaboradorId}`,
      metadados: {
        acao: 'atraso_equipe',
        colaboradorId,
        colaboradorNome: colabNome,
        marcacaoId,
        minutosAtraso,
        dataOcorrencia,
      },
      pushSeveridade: 'atencao',
    }).catch((err) => console.error('[Notificação] Erro ao notificar gestor sobre atraso:', err));
  }
}

/**
 * Notifica os interessados (gestor designado no processo + colaboradores
 * com permissão `notificacao:candidato_compareceu`) quando o candidato
 * marca presença no dia de teste.
 */
export async function notificarCandidatoCompareceu(params: {
  agendamentoId: string | number;
  candidatoNome: string;
  cargoNome?: string | null;
  gestorId?: number | null;
  marcadoPorId: number;
}): Promise<void> {
  const { agendamentoId, candidatoNome, cargoNome, gestorId, marcadoPorId } = params;

  const ids = new Set<number>();
  if (gestorId) ids.add(gestorId);

  const comPermissao = await obterColaboradoresComPermissao('notificacao:candidato_compareceu');
  for (const id of comPermissao) ids.add(id);

  // Quem marcou comparecimento já sabe — não disparar pra si mesmo.
  ids.delete(marcadoPorId);
  if (ids.size === 0) return;

  const titulo = 'Candidato compareceu ao dia de teste';
  const mensagem = cargoNome
    ? `${candidatoNome} (${cargoNome}) chegou para o dia de teste.`
    : `${candidatoNome} chegou para o dia de teste.`;

  for (const usuarioId of ids) {
    criarNotificacaoComPush({
      usuarioId,
      tipo: 'alerta',
      titulo,
      mensagem,
      link: `/recrutamento/dia-teste/${agendamentoId}`,
      metadados: {
        acao: 'candidato_compareceu',
        agendamentoId,
        candidatoNome,
        cargoNome: cargoNome ?? null,
      },
      pushSeveridade: 'info',
    }).catch((err) => console.error('[Notificação] Erro ao notificar candidato compareceu:', err));
  }
}
