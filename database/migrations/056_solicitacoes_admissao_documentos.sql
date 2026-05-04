-- Migration: 056_solicitacoes_admissao_documentos
-- Permite enviar MAIS DE UM documento (contrato + regimento interno + outros)
-- por solicitação de pré-admissão. Hoje a coluna `documento_assinatura_id` em
-- solicitacoes_admissao é singular: só rastreia 1 envelope SignProof por
-- candidato.
--
-- Esta tabela 1:N rastreia cada documento separadamente. O status_checker
-- agrega: a solicitação só vai pra `contrato_assinado` quando TODOS os
-- documentos da solicitação estiverem em `assinado`.
--
-- A coluna `documento_assinatura_id` em solicitacoes_admissao continua
-- preenchida com o doc primário (primeiro do array, ordem=0) por compat com
-- queries legadas (push de assinatura, signing-link cron, auditoria de
-- cancelamento). Pode ser removida em migration futura quando todo consumer
-- ler da tabela nova.
--
-- Aditiva e idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS people.solicitacoes_admissao_documentos (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitacao_id    UUID         NOT NULL REFERENCES people.solicitacoes_admissao(id) ON DELETE CASCADE,
  signproof_doc_id  TEXT         NOT NULL,
  template_id       TEXT,
  titulo            TEXT,
  ordem             INTEGER      NOT NULL DEFAULT 0,
  status            TEXT         NOT NULL DEFAULT 'enviado',
  external_ref      TEXT,
  assinado_em       TIMESTAMPTZ,
  cancelado_em      TIMESTAMPTZ,
  rejeitado_em      TIMESTAMPTZ,
  motivo_rejeicao   TEXT,
  criado_em         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sol_adm_docs_signproof_doc UNIQUE (signproof_doc_id),
  CONSTRAINT chk_sol_adm_docs_status CHECK (status IN ('enviado', 'assinado', 'rejeitado', 'cancelado'))
);

CREATE INDEX IF NOT EXISTS idx_sol_adm_docs_solicitacao
  ON people.solicitacoes_admissao_documentos(solicitacao_id);

-- Índice parcial pra acelerar o status_checker (só docs ainda pendentes).
CREATE INDEX IF NOT EXISTS idx_sol_adm_docs_pendentes
  ON people.solicitacoes_admissao_documentos(solicitacao_id)
  WHERE status = 'enviado';

-- Trigger de atualizado_em (segue padrão das outras tabelas).
DROP TRIGGER IF EXISTS trg_sol_adm_docs_atualizar ON people.solicitacoes_admissao_documentos;
CREATE TRIGGER trg_sol_adm_docs_atualizar
  BEFORE UPDATE ON people.solicitacoes_admissao_documentos
  FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

-- Backfill: para cada solicitação que JÁ tem documento_assinatura_id,
-- inserimos uma linha refletindo o estado atual. Mapeia status da
-- solicitação para status do documento individual (best-effort).
INSERT INTO people.solicitacoes_admissao_documentos
  (solicitacao_id, signproof_doc_id, ordem, status, criado_em, atualizado_em)
SELECT
  s.id,
  s.documento_assinatura_id,
  0,
  CASE
    WHEN s.status = 'contrato_assinado' THEN 'assinado'
    WHEN s.status = 'cancelado'         THEN 'cancelado'
    WHEN s.status = 'rejeitado'         THEN 'rejeitado'
    WHEN s.status = 'admitido'          THEN 'assinado'
    ELSE 'enviado'
  END,
  COALESCE(s.atualizado_em, NOW()),
  COALESCE(s.atualizado_em, NOW())
FROM people.solicitacoes_admissao s
WHERE s.documento_assinatura_id IS NOT NULL
ON CONFLICT (signproof_doc_id) DO NOTHING;

COMMENT ON TABLE people.solicitacoes_admissao_documentos IS
  'Rastreia 1:N os documentos SignProof enviados por solicitação de pré-admissão. A solicitação só transita para contrato_assinado quando TODOS os documentos aqui estão em status=assinado.';
COMMENT ON COLUMN people.solicitacoes_admissao_documentos.signproof_doc_id IS
  'ID do envelope retornado pelo SignProof após POST /signproof/documents. Único globalmente.';
COMMENT ON COLUMN people.solicitacoes_admissao_documentos.template_id IS
  'ID do template SignProof usado pra criar o documento. Permite reidentificar tipo (contrato, regimento, etc).';
COMMENT ON COLUMN people.solicitacoes_admissao_documentos.titulo IS
  'Título humano do documento (ex.: "Contrato de admissão", "Regimento interno"). Usado em logs e mensagens WhatsApp.';
COMMENT ON COLUMN people.solicitacoes_admissao_documentos.ordem IS
  'Ordem de envio (0 = primário, 1 = segundo, ...). Espelha a ordem que o DP escolheu no modal.';
COMMENT ON COLUMN people.solicitacoes_admissao_documentos.status IS
  'enviado | assinado | rejeitado | cancelado. Alimentado pelo signproof-status-checker.';

COMMIT;
