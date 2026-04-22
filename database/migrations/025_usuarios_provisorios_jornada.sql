-- Migration: 025_usuarios_provisorios_jornada
-- Adiciona jornada_id a usuarios_provisorios.
-- A coluna fica NULL-able por enquanto (registros antigos podem não ter jornada).
-- Promoção para NOT NULL é fora do escopo — depende de backfill manual.

ALTER TABLE people.usuarios_provisorios
  ADD COLUMN IF NOT EXISTS jornada_id INTEGER
  REFERENCES people.jornadas(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_jornada
  ON people.usuarios_provisorios (jornada_id);

COMMENT ON COLUMN people.usuarios_provisorios.jornada_id IS 'Jornada do candidato — vínculo obrigatório no POST a partir da task 025';
