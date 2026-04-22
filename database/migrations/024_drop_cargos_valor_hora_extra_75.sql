-- Migration: 024_drop_cargos_valor_hora_extra_75
-- Remove a coluna valor_hora_extra_75 da tabela cargos.
-- O valor é trivialmente derivado de salario_medio / 220 * 1.75
-- e agora é calculado on-the-fly onde necessário.

ALTER TABLE people.cargos
  DROP COLUMN IF EXISTS valor_hora_extra_75;
