-- =====================================================
-- MIGRAÇÃO 059: Timestamps das etapas da admissão
--
-- Adiciona em people.solicitacoes_admissao:
--   - aso_recebido_em        TIMESTAMPTZ : quando RH transitou para 'aso_recebido'
--   - assinatura_solicitada_em TIMESTAMPTZ : quando RH transitou para 'assinatura_solicitada'
--
-- Permite a timeline do modal "Pré-admitidos" mostrar data de cada etapa
-- (ASO solicitado, ASO recebido, Contrato enviado, Contrato assinado).
-- aso_solicitado_em e contrato_assinado_em já existiam.
-- =====================================================

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS aso_recebido_em          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assinatura_solicitada_em TIMESTAMPTZ;

-- Backfill best-effort: rows atualmente nesse status ganham o atualizado_em.
-- Rows que já avançaram não têm esse timestamp histórico — ficam NULL e a UI
-- mostra "—" (mesmo comportamento de antes, sem regredir nada).
UPDATE people.solicitacoes_admissao
   SET aso_recebido_em = atualizado_em
 WHERE status = 'aso_recebido'
   AND aso_recebido_em IS NULL;

UPDATE people.solicitacoes_admissao
   SET assinatura_solicitada_em = atualizado_em
 WHERE status = 'assinatura_solicitada'
   AND assinatura_solicitada_em IS NULL;

COMMENT ON COLUMN people.solicitacoes_admissao.aso_recebido_em IS
  'Timestamp em que o RH transitou para aso_recebido';
COMMENT ON COLUMN people.solicitacoes_admissao.assinatura_solicitada_em IS
  'Timestamp em que o RH transitou para assinatura_solicitada (contrato enviado)';
