-- =====================================================
-- 043 — dia_teste_agendamento.comparecimento_em
-- =====================================================
-- A regra §3.6 do FLUXO_RECRUTAMENTO bloqueia o gestor de
-- aprovar/reprovar antes de 50% da carga horária ter sido
-- cumprida. Pra calcular isso precisamos saber QUANDO o
-- candidato foi marcado como "compareceu" — não basta o
-- `atualizado_em`, que pode mudar por outros motivos
-- (ex: edição de gestor_id, percentual_concluido etc.).
--
-- Coluna nova: comparecimento_em (set pelo endpoint
-- /compareceu, NULL nos demais status).
--
-- Backfill: agendamentos já em 'compareceu' antes da
-- migration herdam `atualizado_em` como aproximação —
-- melhor do que NULL pra cálculos retroativos.
--
-- Idempotente.
-- =====================================================

ALTER TABLE people.dia_teste_agendamento
  ADD COLUMN IF NOT EXISTS comparecimento_em TIMESTAMPTZ;

UPDATE people.dia_teste_agendamento
   SET comparecimento_em = atualizado_em
 WHERE status = 'compareceu' AND comparecimento_em IS NULL;
