-- 053_popup_avaliacao_ia.sql
--
-- Parametriza a frequência com que o popup de feedback IA aparece pro
-- recrutador, independente da frequência da avaliação IA em si.
--
--   - popup_modo: 'por_avaliacao' (popup quando acumular N novas
--     avaliações pendentes) ou 'por_dias' (popup a cada N dias desde
--     o último popup visto, desde que haja ≥ 1 avaliação pendente).
--   - popup_intervalo: N (avaliações ou dias, conforme o modo). Default 1.

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS popup_modo TEXT NOT NULL DEFAULT 'por_avaliacao',
  ADD COLUMN IF NOT EXISTS popup_intervalo INT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'parametros_rh_popup_modo_chk'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_popup_modo_chk
      CHECK (popup_modo IN ('por_avaliacao', 'por_dias'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'parametros_rh_popup_intervalo_chk'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_popup_intervalo_chk
      CHECK (popup_intervalo BETWEEN 1 AND 365);
  END IF;
END $$;
