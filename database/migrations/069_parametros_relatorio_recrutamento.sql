-- 069_parametros_relatorio_recrutamento.sql
--
-- Adiciona parametro de duracao minima de entrevista em
-- people.parametros_rh. Entrevistas com duracao_seg >= esse valor
-- (em minutos, convertido) entram nas estatisticas como "validas"
-- no novo dashboard de Relatorio de Recrutamento.

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS duracao_minima_entrevista_minutos INT NOT NULL DEFAULT 5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'parametros_rh_duracao_minima_entrevista_chk'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_duracao_minima_entrevista_chk
      CHECK (duracao_minima_entrevista_minutos BETWEEN 0 AND 240);
  END IF;
END $$;
