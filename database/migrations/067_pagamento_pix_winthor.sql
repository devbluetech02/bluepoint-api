-- =====================================================
-- MIGRAÇÃO 067: Lançamento Winthor por pagamento PIX
--
-- Usado pela integração que registra cada PIX a candidato em dia de
-- teste como conta a pagar no ERP Winthor (WINDOW.PCLANC).
--
-- - winthor_recnum     : RECNUM gerado por FERRAMENTAS.F_PROX_RECNUM
--                        e usado no INSERT. Idempotência: se NOT NULL,
--                        o lançamento já foi feito e não será refeito.
-- - winthor_lancado_em : timestamp do INSERT bem-sucedido
-- - winthor_erro       : última mensagem de erro, se houve falha
--                        (cron retry usa pra reprocessar)
-- =====================================================

ALTER TABLE people.pagamento_pix
  ADD COLUMN IF NOT EXISTS winthor_recnum     BIGINT,
  ADD COLUMN IF NOT EXISTS winthor_lancado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS winthor_erro       TEXT;

CREATE INDEX IF NOT EXISTS idx_pagamento_pix_winthor_pendente
  ON people.pagamento_pix (status)
  WHERE status = 'sucesso' AND winthor_recnum IS NULL;

COMMENT ON COLUMN people.pagamento_pix.winthor_recnum IS
  'RECNUM no ERP Winthor (PCLANC.RECNUM). NULL = ainda não lançado. '
  'Quando preenchido, marca o pagamento como já registrado no contábil.';
COMMENT ON COLUMN people.pagamento_pix.winthor_erro IS
  'Última mensagem de erro do INSERT no Winthor — reprocessável pelo cron.';
