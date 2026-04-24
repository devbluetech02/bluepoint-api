import { query } from '@/lib/db';

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

interface SolicitacaoPendente {
  id: string;
  documento_assinatura_id: string;
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
 * Verifica no SignProof o status dos contratos em `assinatura_solicitada`
 * e atualiza a solicitação correspondente quando o documento for finalizado
 * (completed) ou rejeitado pelo signatário (rejected).
 *
 * Idempotente: o UPDATE usa WHERE status = 'assinatura_solicitada' como guarda
 * contra race conditions.
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

  // 1. Busca solicitações com contrato pendente de assinatura e documento vinculado
  const pendentesResult = await query<SolicitacaoPendente>(
    `SELECT id, documento_assinatura_id
       FROM people.solicitacoes_admissao
      WHERE status = 'assinatura_solicitada'
        AND documento_assinatura_id IS NOT NULL`
  );
  const pendentes = pendentesResult.rows;

  if (pendentes.length === 0) {
    console.log('[SignProof Checker] Nenhuma solicitação em assinatura_solicitada — ciclo encerrado.');
    return resultado;
  }

  console.log(`[SignProof Checker] ${pendentes.length} solicitação(ões) para verificar.`);

  // Mapa: documento_assinatura_id → solicitacao.id
  const docToSolicitacao = new Map<string, string>();
  for (const p of pendentes) docToSolicitacao.set(p.documento_assinatura_id, p.id);

  // 2. Chunks de até 100 IDs
  const allDocIds = Array.from(docToSolicitacao.keys());
  const chunks: string[][] = [];
  for (let i = 0; i < allDocIds.length; i += BATCH_SIZE) {
    chunks.push(allDocIds.slice(i, i + BATCH_SIZE));
  }

  // 3. Consulta o SignProof chunk a chunk
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

  // 4. Para cada documento retornado, atualiza a solicitação correspondente
  for (const doc of allDocs) {
    const solicitacaoId = docToSolicitacao.get(doc.id);
    if (!solicitacaoId) {
      console.warn(`[SignProof Checker] Documento ${doc.id} retornado mas sem solicitação mapeada (pulando).`);
      continue;
    }

    try {
      if (doc.status === 'completed') {
        // UPDATE com guarda em status — garante idempotência
        const upd = await query<{ id: string }>(
          `UPDATE people.solicitacoes_admissao
              SET status = 'contrato_assinado',
                  contrato_assinado_em = NOW(),
                  atualizado_em = NOW()
            WHERE id = $1
              AND status = 'assinatura_solicitada'
          RETURNING id`,
          [solicitacaoId]
        );
        if (upd.rowCount && upd.rowCount > 0) {
          resultado.documentos_atualizados++;
          resultado.atualizacoes.push({ solicitacaoId, novoStatus: 'contrato_assinado' });
          console.log(`[SignProof Checker] Solicitação ${solicitacaoId} → contrato_assinado (doc ${doc.id}).`);
        }
      } else if (doc.status === 'rejected') {
        // Candidato clicou "Rejeitar" na tela de assinatura da SignProof —
        // é uma recusa deliberada, não uma correção de formulário. Vai
        // direto pra 'rejeitado' (terminal) com motivo padrão; DP decide
        // se quer reabrir manualmente.
        const upd = await query<{ id: string }>(
          `UPDATE people.solicitacoes_admissao
              SET status = 'rejeitado',
                  motivo_rejeicao = COALESCE(motivo_rejeicao, 'Candidato rejeitou a assinatura do contrato'),
                  atualizado_em = NOW()
            WHERE id = $1
              AND status = 'assinatura_solicitada'
          RETURNING id`,
          [solicitacaoId]
        );
        if (upd.rowCount && upd.rowCount > 0) {
          resultado.documentos_atualizados++;
          resultado.atualizacoes.push({ solicitacaoId, novoStatus: 'rejeitado' });
          console.log(`[SignProof Checker] Solicitação ${solicitacaoId} → rejeitado (signer recusou doc ${doc.id}).`);
        }
      } else if (doc.status === 'cancelled') {
        // Política: mantém status atual; apenas loga o evento
        console.log(`[SignProof Checker] Documento ${doc.id} (solicitação ${solicitacaoId}) cancelled — status da solicitação mantido.`);
      }
      // Demais status (pending, sent, etc.) — nada a fazer
    } catch (err) {
      const msg = `Falha ao atualizar solicitação ${solicitacaoId}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[SignProof Checker] ${msg}`);
      resultado.erros.push(msg);
    }
  }

  console.log(
    `[SignProof Checker] Ciclo concluído: ${resultado.documentos_verificados} verificado(s), ${resultado.documentos_atualizados} atualizado(s), ${resultado.erros.length} erro(s).`
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
