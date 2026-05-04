-- =====================================================
-- 052 — Cargo de confiança
-- =====================================================
-- Marca cargos cujos colaboradores não batem ponto e/ou não precisam
-- assinar relatório de ponto mensal (diretores, sócios, executivos C-level
-- etc.). Reflexos no sistema:
--   1. Push "Relatório de ponto disponível" e lembretes de contestação
--      (alertas-periodicos.ts) ignoram colaboradores em cargos de confiança.
--   2. Indicadores e dashboards de horários (visão geral, status tempo real,
--      painel de presença) excluem esses colaboradores — não fazem sentido
--      em "atrasados", "presentes hoje", etc.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + DEFAULT FALSE.
-- =====================================================

ALTER TABLE people.cargos
  ADD COLUMN IF NOT EXISTS cargo_confianca BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cargos_confianca
  ON people.cargos(cargo_confianca)
  WHERE cargo_confianca = TRUE;

COMMENT ON COLUMN people.cargos.cargo_confianca IS
  'Quando TRUE, colaboradores deste cargo nao batem ponto, nao recebem push de relatorio mensal nem aparecem em indicadores de horario.';
