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
  /**
   * Janela de deduplicação em segundos. Se já existe notificação com
   * mesmos campos (usuario+tipo+titulo+mensagem+metadados+link) NÃO LIDA
   * dentro dessa janela, o INSERT é pulado e retorna null.
   *
   * Default 3600 (1h). Cobre retries de worker, race em multi-device e
   * disparos duplicados acidentais. Casos onde a mesma mensagem deve
   * aparecer várias vezes (ex.: lembretes diários) devem usar janela
   * curta (ex.: 60) ou variar metadados (ex.: incluir data).
   */
  dedupSegundos?: number;
}

/**
 * Cria uma notificação na tabela notificacoes.
 * Retorna o ID da notificação criada ou null em caso de falha OU dedup
 * (nada inserido porque já havia notificação igual recente não lida).
 */
export async function criarNotificacao(params: CriarNotificacaoParams): Promise<number | null> {
  const dedupSec = params.dedupSegundos ?? 3600;
  try {
    const metadadosJson = params.metadados ? JSON.stringify(params.metadados) : null;
    // INSERT condicional: só insere se NÃO existe duplicada não lida na janela.
    // SELECT 1 FROM ... WHERE ... funciona como guard at-most-once sem lock.
    // Em race condition entre 2 inserts simultâneos pode escapar 1 duplicado
    // (NOT EXISTS é avaliado no início da query) — aceitável; client-side
    // dedup pega o resíduo. Solução perfeita exigiria UNIQUE INDEX
    // composto + ON CONFLICT, o que demanda migration.
    const result = await query<{ id: number }>(
      `INSERT INTO people.notificacoes (usuario_id, tipo, titulo, mensagem, link, metadados)
       SELECT $1, $2, $3, $4, $5, $6::jsonb
       WHERE NOT EXISTS (
         SELECT 1
           FROM people.notificacoes
          WHERE usuario_id = $1
            AND tipo       = $2
            AND titulo     = $3
            AND mensagem   = $4
            AND COALESCE(link,'')               = COALESCE($5,'')
            AND COALESCE(metadados::text,'')    = COALESCE($6::text,'')
            AND lida       = false
            AND data_envio > NOW() - ($7::int * interval '1 second')
       )
       RETURNING id`,
      [
        params.usuarioId,
        params.tipo,
        params.titulo,
        params.mensagem,
        params.link || null,
        metadadosJson,
        dedupSec,
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

  // Skip push quando dedupado: id null = duplicata recente, não há razão
  // pra spammar o usuário com o mesmo push de novo.
  if (id == null) {
    return null;
  }

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
