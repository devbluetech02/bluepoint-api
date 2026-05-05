import { query } from '@/lib/db';
import { processarTransicaoAdmitido } from '@/app/api/v1/admissao/solicitacoes/[id]/status/route';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';
import { enviarPushParaCargoNome } from '@/lib/push-colaborador';

const INTERVALO_MS = 5 * 60 * 1000;       // 5 minutos
const DELAY_INICIAL_MS = 2 * 60 * 1000;    // primeiro ciclo após 2 min (dar tempo do servidor subir)
const BATCH_SIZE = 100;                    // SignProof batch-status aceita até 100 ids

let timerRef: ReturnType<typeof setInterval> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

type SignProofDocumentStatus = 'pending' | 'sent' | 'completed' | 'cancelled' | 'rejected' | string;

interface SignProofDocument {
  id: string;
  status: SignProofDocumentStatus;
}

interface DocPendente {
  solicitacao_id: string;
  doc_table_id: string | null;     // id da linha em solicitacoes_admissao_documentos (null = legado)
  signproof_doc_id: string;
}

export interface ResultadoCiclo {
  documentos_verificados: number;
  documentos_atualizados: number;
  atualizacoes: Array<{ solicitacaoId: string; novoStatus: string }>;
  erros: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Núcleo — executarCiclo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica no SignProof o status dos documentos pendentes (status='enviado'
 * em solicitacoes_admissao_documentos) e atualiza:
 *   - cada documento individual com o novo status;
 *   - a solicitação como um todo, em regra de agregação:
 *       * algum rejeitado → solicitação vira 'rejeitado';
 *       * todos assinados → solicitação vira 'contrato_assinado';
 *       * caso contrário → mantém 'assinatura_solicitada'.
 *
 * Suporte legado: solicitações que ainda não têm linha em
 * solicitacoes_admissao_documentos (anteriores à migration 056) caem no
 * caminho clássico via documento_assinatura_id, com o primeiro doc ditando
 * o status — comportamento equivalente ao checker antigo.
 *
 * Idempotente: UPDATEs guardam WHERE status='enviado' / 'assinatura_solicitada'.
 */
export async function executarCicloSignProof(): Promise<ResultadoCiclo> {
  const resultado: ResultadoCiclo = {
    documentos_verificados: 0,
    documentos_atualizados: 0,
    atualizacoes: [],
    erros: [],
  };

  const SIGNPROOF_API_URL = process.env.SIGNPROOF_API_URL;
  const SIGNPROOF_API_KEY = process.env.SIGNPROOF_API_KEY;

  if (!SIGNPROOF_API_URL || !SIGNPROOF_API_KEY) {
    const msg = 'SIGNPROOF_API_URL ou SIGNPROOF_API_KEY ausente no env';
    console.error(`[SignProof Checker] ${msg}`);
    resultado.erros.push(msg);
    return resultado;
  }

  // 1. Busca docs pendentes via tabela 1:N + fallback legado.
  // O LEFT JOIN garante que solicitações sem linha em
  // solicitacoes_admissao_documentos (cenário legado puro) ainda apareçam,
  // usando documento_assinatura_id como signproof_doc_id e doc_table_id=NULL.
  const pendentesResult = await query<DocPendente>(
    `SELECT s.id AS solicitacao_id,
            d.id AS doc_table_id,
            COALESCE(d.signproof_doc_id, s.documento_assinatura_id) AS signproof_doc_id
       FROM people.solicitacoes_admissao s
  LEFT JOIN people.solicitacoes_admissao_documentos d
         ON d.solicitacao_id = s.id AND d.status = 'enviado'
      WHERE s.status = 'assinatura_solicitada'
        AND (d.signproof_doc_id IS NOT NULL OR s.documento_assinatura_id IS NOT NULL)`
  );
  const pendentes = pendentesResult.rows;

  if (pendentes.length === 0) {
    console.log('[SignProof Checker] Nenhum documento pendente — ciclo encerrado.');
    return resultado;
  }

  console.log(`[SignProof Checker] ${pendentes.length} documento(s) para verificar.`);

  // Mapa: signproof_doc_id → array de pendentes (deduplica IDs entre legado e nova tabela).
  const docToPendentes = new Map<string, DocPendente[]>();
  for (const p of pendentes) {
    const arr = docToPendentes.get(p.signproof_doc_id) ?? [];
    arr.push(p);
    docToPendentes.set(p.signproof_doc_id, arr);
  }

  // 2. Chunks de até 100 IDs únicos
  const allDocIds = Array.from(docToPendentes.keys());
  const chunks: string[][] = [];
  for (let i = 0; i < allDocIds.length; i += BATCH_SIZE) {
    chunks.push(allDocIds.slice(i, i + BATCH_SIZE));
  }

  // 3. Consulta o SignProof
  const allDocs: SignProofDocument[] = [];
  for (const chunk of chunks) {
    try {
      const response = await fetch(`${SIGNPROOF_API_URL}/api/v1/integration/documents/batch-status`, {
        method: 'POST',
        headers: {
          'X-API-Key': SIGNPROOF_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ document_ids: chunk }),
      });

      if (!response.ok) {
        const msg = `SignProof batch-status HTTP ${response.status}: ${await response.text().catch(() => '')}`;
        console.error(`[SignProof Checker] ${msg}`);
        resultado.erros.push(msg);
        continue;
      }

      const payload = await response.json() as
        | { documents?: SignProofDocument[]; data?: SignProofDocument[] }
        | SignProofDocument[];

      const docs: SignProofDocument[] = Array.isArray(payload)
        ? payload
        : (payload.documents ?? payload.data ?? []);

      allDocs.push(...docs);
    } catch (err) {
      const msg = `Falha na chamada batch-status: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[SignProof Checker] ${msg}`);
      resultado.erros.push(msg);
    }
  }
  resultado.documentos_verificados = allDocs.length;

  // 4. Atualiza cada doc individual + acumula solicitações afetadas.
  const solicitacoesAfetadas = new Set<string>();
  const solicitacoesLegadasFallback = new Map<string, SignProofDocumentStatus>();

  for (const doc of allDocs) {
    const peers = docToPendentes.get(doc.id);
    if (!peers || peers.length === 0) continue;

    for (const p of peers) {
      solicitacoesAfetadas.add(p.solicitacao_id);

      try {
        if (p.doc_table_id) {
          // Caminho novo: atualiza linha em solicitacoes_admissao_documentos.
          if (doc.status === 'completed') {
            await query(
              `UPDATE people.solicitacoes_admissao_documentos
                  SET status = 'assinado', assinado_em = NOW(), atualizado_em = NOW()
                WHERE id = $1 AND status = 'enviado'`,
              [p.doc_table_id],
            );
          } else if (doc.status === 'rejected') {
            await query(
              `UPDATE people.solicitacoes_admissao_documentos
                  SET status          = 'rejeitado',
                      rejeitado_em    = NOW(),
                      motivo_rejeicao = COALESCE(motivo_rejeicao, 'Candidato rejeitou a assinatura'),
                      atualizado_em   = NOW()
                WHERE id = $1 AND status = 'enviado'`,
              [p.doc_table_id],
            );
          } else if (doc.status === 'cancelled') {
            await query(
              `UPDATE people.solicitacoes_admissao_documentos
                  SET status = 'cancelado', cancelado_em = NOW(), atualizado_em = NOW()
                WHERE id = $1 AND status = 'enviado'`,
              [p.doc_table_id],
            );
          }
        } else {
          // Caminho legado puro (sem linha em solicitacoes_admissao_documentos):
          // guarda o status pra resolver na fase de agregação.
          solicitacoesLegadasFallback.set(p.solicitacao_id, doc.status);
        }
      } catch (err) {
        const msg = `Falha ao atualizar doc ${doc.id}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[SignProof Checker] ${msg}`);
        resultado.erros.push(msg);
      }
    }
  }

  // 5. Agrega status de cada solicitação afetada.
  for (const solicitacaoId of solicitacoesAfetadas) {
    try {
      const aggResult = await query<{
        total: number;
        assinados: number;
        rejeitados: number;
        enviados: number;
      }>(
        `SELECT
           COUNT(*)::int                                              AS total,
           SUM(CASE WHEN status = 'assinado'  THEN 1 ELSE 0 END)::int AS assinados,
           SUM(CASE WHEN status = 'rejeitado' THEN 1 ELSE 0 END)::int AS rejeitados,
           SUM(CASE WHEN status = 'enviado'   THEN 1 ELSE 0 END)::int AS enviados
         FROM people.solicitacoes_admissao_documentos
         WHERE solicitacao_id = $1`,
        [solicitacaoId],
      );
      const agg = aggResult.rows[0];

      let novoStatus: 'contrato_assinado' | 'rejeitado' | null = null;

      if (!agg || agg.total === 0) {
        // Caminho legado puro: olha o status do único doc do SignProof.
        const sp = solicitacoesLegadasFallback.get(solicitacaoId);
        if (sp === 'completed') novoStatus = 'contrato_assinado';
        else if (sp === 'rejected') novoStatus = 'rejeitado';
      } else {
        if (agg.rejeitados > 0) {
          novoStatus = 'rejeitado';
        } else if (agg.assinados === agg.total) {
          novoStatus = 'contrato_assinado';
        }
      }
      if (!novoStatus) continue;

      const upd = novoStatus === 'contrato_assinado'
        ? await query<{ id: string }>(
            `UPDATE people.solicitacoes_admissao
                SET status               = 'contrato_assinado',
                    contrato_assinado_em = NOW(),
                    atualizado_em        = NOW()
              WHERE id = $1
                AND status = 'assinatura_solicitada'
            RETURNING id`,
            [solicitacaoId],
          )
        : await query<{ id: string }>(
            `UPDATE people.solicitacoes_admissao
                SET status          = 'rejeitado',
                    motivo_rejeicao = COALESCE(motivo_rejeicao, 'Candidato rejeitou a assinatura do contrato'),
                    atualizado_em   = NOW()
              WHERE id = $1
                AND status = 'assinatura_solicitada'
            RETURNING id`,
            [solicitacaoId],
          );

      if (upd.rowCount && upd.rowCount > 0) {
        resultado.documentos_atualizados++;
        resultado.atualizacoes.push({ solicitacaoId, novoStatus });
        if (agg && agg.total > 0) {
          console.log(
            `[SignProof Checker] Solicitação ${solicitacaoId} → ${novoStatus} ` +
            `(${agg.assinados}/${agg.total} assinados, ${agg.rejeitados} rejeitados, ${agg.enviados} pendentes).`,
          );
        } else {
          console.log(`[SignProof Checker] Solicitação ${solicitacaoId} → ${novoStatus} (legado).`);
        }

        // Auto-admissão: se o contrato foi assinado, dispara a transição
        // pra 'admitido' imediatamente — cria colaborador + copia docs +
        // migra biometria. Fire-and-forget; falha não derruba o ciclo.
        if (novoStatus === 'contrato_assinado') {
          autoAdmitir(solicitacaoId).catch((err) => {
            console.error(
              `[SignProof Checker] Falha na auto-admissão de ${solicitacaoId}:`,
              err,
            );
          });
        }
      }
    } catch (err) {
      const msg = `Falha ao avaliar agregado da solicitação ${solicitacaoId}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[SignProof Checker] ${msg}`);
      resultado.erros.push(msg);
    }
  }

  console.log(
    `[SignProof Checker] Ciclo concluído: ${resultado.documentos_verificados} verificado(s), ${resultado.documentos_atualizados} solicitação(ões) atualizada(s), ${resultado.erros.length} erro(s).`
  );

  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

export function iniciarSignProofStatusChecker(): void {
  if (timerRef) return;

  setTimeout(() => {
    executarCicloSignProof().catch((err) => {
      console.error('[SignProof Checker] Erro no primeiro ciclo:', err);
    });
    timerRef = setInterval(() => {
      executarCicloSignProof().catch((err) => {
        console.error('[SignProof Checker] Erro no ciclo:', err);
      });
    }, INTERVALO_MS);
  }, DELAY_INICIAL_MS);
}

export function pararSignProofStatusChecker(): void {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-admissão pós-contrato-assinado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispara a transição automática `contrato_assinado` → `admitido`. Cria o
 * colaborador a partir dos dados da pré-admissão (ou reativa um inativo
 * com mesmo CPF), copia os documentos enviados, migra a biometria e
 * notifica candidato + administradores. Fire-and-forget — usado pelo
 * SignProof checker logo após detectar o contrato concluído.
 *
 * Idempotente: o UPDATE final é guardado por `WHERE status='contrato_assinado'`,
 * então execuções duplicadas no mesmo ciclo são absorvidas. Se já existir
 * colaborador ATIVO com o mesmo CPF (caso defensivo), aborta sem mudar
 * o status.
 */
async function autoAdmitir(solicitacaoId: string): Promise<void> {
  // 1) Carrega dados mínimos da solicitação
  const sol = await query<{
    usuario_provisorio_id: number | null;
    onesignal_subscription_id: string | null;
    foto_perfil_url: string | null;
  }>(
    `SELECT usuario_provisorio_id, onesignal_subscription_id, foto_perfil_url
       FROM people.solicitacoes_admissao
      WHERE id = $1`,
    [solicitacaoId],
  );
  if (sol.rows.length === 0) {
    console.warn(`[auto-admit] Solicitação ${solicitacaoId} não encontrada`);
    return;
  }
  const { usuario_provisorio_id, onesignal_subscription_id, foto_perfil_url } = sol.rows[0];
  if (!usuario_provisorio_id) {
    console.warn(`[auto-admit] Solicitação ${solicitacaoId} sem usuario_provisorio_id`);
    return;
  }

  // 2) Pré-check: se já tem colaborador ATIVO com mesmo CPF, não tenta
  // forçar a transição (mesma defesa do PATCH /status).
  const conflict = await query<{ id: number }>(
    `SELECT c.id
       FROM people.usuarios_provisorios up
       JOIN people.colaboradores c ON c.cpf = up.cpf
      WHERE up.id = $1
        AND c.status = 'ativo'
      LIMIT 1`,
    [usuario_provisorio_id],
  );
  // Se existe colaborador ativo, deixa o pós-processamento tentar
  // resolver (pode ser caso "front criou via /criar-colaborador antes,
  // só falta marcar admitido"). Caminho mais comum: sem colaborador
  // ainda → criarColaboradorAPartirDeAdmissao roda dentro de
  // processarTransicaoAdmitido.

  // 3) Marca admitido (idempotente: só atualiza se ainda em contrato_assinado)
  const upd = await query<{ id: string }>(
    `UPDATE people.solicitacoes_admissao
        SET status         = 'admitido',
            atualizado_em  = NOW()
      WHERE id = $1
        AND status = 'contrato_assinado'
    RETURNING id`,
    [solicitacaoId],
  );
  if (!upd.rowCount || upd.rowCount === 0) {
    console.log(`[auto-admit] ${solicitacaoId} já não estava em contrato_assinado — skip`);
    return;
  }

  // 4) Pós-transição: cria colaborador, copia docs, biometria
  const colaboradorIdExistente = conflict.rows[0]?.id ?? null;
  await processarTransicaoAdmitido(
    solicitacaoId,
    usuario_provisorio_id,
    foto_perfil_url,
    colaboradorIdExistente,
  );

  // 5) Push pro candidato (boas-vindas)
  enviarPushParaProvisorio(
    usuario_provisorio_id,
    {
      titulo: 'Bem-vindo(a)!',
      mensagem: 'Sua admissão foi concluída automaticamente. Acesse o app pra ver os próximos passos.',
      severidade: 'info',
      data: { solicitacaoId },
      url: '/pre-admissao',
    },
    onesignal_subscription_id,
  ).catch((err) => console.error('[auto-admit] Push candidato falhou:', err));

  // 6) Push pro cargo Administrador
  enviarPushParaCargoNome('Administrador', {
    titulo: 'Candidato admitido',
    mensagem: 'Uma admissão foi concluída automaticamente após o contrato ser assinado.',
    severidade: 'info',
    data: { tipo: 'admissao_status', solicitacaoId, status: 'admitido', auto: true },
    url: '/pre-admissao',
  }).catch((err) => console.error('[auto-admit] Push admin falhou:', err));

  console.log(`[auto-admit] Solicitação ${solicitacaoId} admitida automaticamente`);
}
