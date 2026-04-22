-- Migration: 016_data_exame_aso_timestamp
-- Converte data_exame_aso de DATE para TIMESTAMPTZ, incorporando hora_exame_aso.
-- Valores existentes são interpretados como horário de Brasília (UTC-3).
-- Após a migração, hora_exame_aso é removida (redundante).

ALTER TABLE people.solicitacoes_admissao
  ALTER COLUMN data_exame_aso TYPE TIMESTAMPTZ
    USING CASE
      WHEN data_exame_aso IS NULL THEN NULL
      WHEN hora_exame_aso IS NOT NULL THEN
        (data_exame_aso::TEXT || ' ' || hora_exame_aso::TEXT || '-03:00')::TIMESTAMPTZ
      ELSE
        (data_exame_aso::TEXT || ' 00:00:00-03:00')::TIMESTAMPTZ
    END;

ALTER TABLE people.solicitacoes_admissao
  DROP COLUMN IF EXISTS hora_exame_aso;

COMMENT ON COLUMN people.solicitacoes_admissao.data_exame_aso IS
  'Data e hora agendada para o exame ASO (TIMESTAMPTZ, armazenado em UTC). '
  'Criado interpretando o horário local como Brasília (UTC-3).';
