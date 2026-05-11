-- Migration: 070_dia_teste_nota_reprovacao
-- Adiciona nota (1 a 5 estrelas) que o gestor atribui ao candidato
-- no momento da reprovação no dia de teste. Exibido na tela de
-- "Dias de teste" no web (coluna Nota) para qualificar reprovações.
--
-- NULL = sem nota (registros pré-feature ou decisões que não sejam
-- 'reprovado'). Backfill não é feito por design.
--
-- Idempotente.

BEGIN;

ALTER TABLE people.dia_teste_agendamento
  ADD COLUMN IF NOT EXISTS nota_reprovacao SMALLINT;

-- CHECK separado (idempotente via DO/EXCEPTION) — Postgres não tem
-- ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dia_teste_agendamento_nota_reprovacao_check'
       AND conrelid = 'people.dia_teste_agendamento'::regclass
  ) THEN
    ALTER TABLE people.dia_teste_agendamento
      ADD CONSTRAINT dia_teste_agendamento_nota_reprovacao_check
      CHECK (nota_reprovacao IS NULL OR nota_reprovacao BETWEEN 1 AND 5);
  END IF;
END $$;

COMMENT ON COLUMN people.dia_teste_agendamento.nota_reprovacao IS
  'Nota de 1 a 5 estrelas atribuída pelo gestor ao candidato no momento da reprovação. NULL pra registros não reprovados ou pré-feature.';

COMMIT;
