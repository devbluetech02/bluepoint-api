-- 074_aderencia_minima_pct.sql
--
-- Adiciona parametro de aderencia minima (em pct 0-100) em
-- people.parametros_rh. Entrevistas com aderencia_ia_pct >= esse
-- valor sao classificadas como "aderentes" no dashboard de
-- Relatorio de Recrutamento (chip "% aderentes" nos cards de KPI).

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS aderencia_minima_pct NUMERIC(5,2) NOT NULL DEFAULT 70;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'parametros_rh_aderencia_minima_pct_chk'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_aderencia_minima_pct_chk
      CHECK (aderencia_minima_pct BETWEEN 0 AND 100);
  END IF;
END $$;
