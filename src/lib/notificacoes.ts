import { query } from '@/lib/db';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { enviarPushParaColaborador, type PushSeveridade } from '@/lib/push-colaborador';

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
