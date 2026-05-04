-- 052_parametros_avaliacao_ia.sql
--
-- Adiciona parâmetros de avaliação IA dos recrutadores em
-- people.parametros_rh:
--   - entrevistas_para_avaliar_ia: a cada N entrevistas com análise IA
--     dum recrutador, dispara nova avaliação. Default 5.
--   - cobertura_minima_entrevista: cobertura % mínima da correlação
--     CV-entrevista pra contar como entrevista "válida" no relatório.
--     Default 50.
--   - avaliacao_ia_ativa: master switch. Se false, cron não roda. Default true.

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS entrevistas_para_avaliar_ia INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS cobertura_minima_entrevista INT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS avaliacao_ia_ativa BOOLEAN NOT NULL DEFAULT true;

-- Sanity checks via CHECK constraints (idempotente — usa DO block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'parametros_rh_entrevistas_para_avaliar_ia_chk'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_entrevistas_para_avaliar_ia_chk
      CHECK (entrevistas_para_avaliar_ia BETWEEN 1 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'parametros_rh_cobertura_minima_entrevista_chk'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_cobertura_minima_entrevista_chk
      CHECK (cobertura_minima_entrevista BETWEEN 0 AND 100);
  END IF;
END $$;
