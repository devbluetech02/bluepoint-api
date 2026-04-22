-- =====================================================
-- MIGRAÇÃO 020: Suporte ao job de verificação SignProof
--
-- Adiciona em people.solicitacoes_admissao:
--   - documento_assinatura_id   UUID      : id do documento no SignProof
--   - contrato_assinado_em      TIMESTAMPTZ : preenchido pelo cron quando SignProof retornar 'completed'
--   - data_admissao             DATE      : data efetiva de admissão informada no PATCH de status
-- =====================================================

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS documento_assinatura_id UUID,
  ADD COLUMN IF NOT EXISTS contrato_assinado_em    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_admissao           DATE;

-- Índice parcial para o cron — filtra eficientemente as poucas solicitações
-- em estado 'assinatura_solicitada' com documento vinculado.
CREATE INDEX IF NOT EXISTS idx_solicitacoes_admissao_signproof_pendentes
  ON people.solicitacoes_admissao (documento_assinatura_id)
  WHERE status = 'assinatura_solicitada' AND documento_assinatura_id IS NOT NULL;

COMMENT ON COLUMN people.solicitacoes_admissao.documento_assinatura_id IS
  'ID do documento no SignProof associado a esta solicitação (preenchido ao transitar para assinatura_solicitada)';
COMMENT ON COLUMN people.solicitacoes_admissao.contrato_assinado_em IS
  'Timestamp em que o SignProof reportou o documento como completed (preenchido pelo cron signproof-status-checker)';
COMMENT ON COLUMN people.solicitacoes_admissao.data_admissao IS
  'Data efetiva de admissão informada pelo RH ao liberar o contrato para assinatura';
