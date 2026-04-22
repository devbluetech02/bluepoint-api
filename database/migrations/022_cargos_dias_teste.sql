-- Migration: 022_cargos_dias_teste
-- Adiciona coluna dias_teste à tabela de cargos.
-- Representa os dias de teste remunerados que o candidato fica avaliado
-- antes da contratação (não é período de experiência CLT).
-- NULL = cargo ainda não configurado.

ALTER TABLE people.cargos
  ADD COLUMN IF NOT EXISTS dias_teste INTEGER;

COMMENT ON COLUMN people.cargos.dias_teste IS 'Dias de teste remunerados do cargo antes da contratação. NULL = não configurado.';
