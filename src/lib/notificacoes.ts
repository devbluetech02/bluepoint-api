import { query } from '@/lib/db';

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
 * Cria uma notificação na tabela bt_notificacoes.
 * Retorna o ID da notificação criada ou null em caso de falha.
 */
export async function criarNotificacao(params: CriarNotificacaoParams): Promise<number | null> {
  try {
    const result = await query(
      `INSERT INTO bluepoint.bt_notificacoes (usuario_id, tipo, titulo, mensagem, link, metadados)
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
    return result.rows[0]?.id ?? null;
  } catch (error) {
    console.error('[Notificação] Erro ao criar notificação:', error);
    return null;
  }
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
  return criarNotificacao({
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
  });
}
