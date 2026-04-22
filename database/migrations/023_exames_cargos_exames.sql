-- Migration: 023_exames_cargos_exames
-- Catálogo global de exames médicos e vínculo N:N com cargos.
-- Informativo apenas — não trava fluxos de negócio.
-- Sem flag 'obrigatorio' no vínculo: todo exame vinculado é obrigatório.

CREATE TABLE IF NOT EXISTS people.exames (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(100) NOT NULL,
  ativo       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_exames_nome_lower
  ON people.exames (LOWER(nome));

CREATE TABLE IF NOT EXISTS people.cargos_exames (
  cargo_id  INTEGER NOT NULL REFERENCES people.cargos(id) ON DELETE CASCADE,
  exame_id  INTEGER NOT NULL REFERENCES people.exames(id) ON DELETE RESTRICT,
  PRIMARY KEY (cargo_id, exame_id)
);

CREATE INDEX IF NOT EXISTS idx_cargos_exames_exame ON people.cargos_exames (exame_id);

COMMENT ON TABLE people.exames IS 'Catálogo global de exames médicos exigidos em contratações.';
COMMENT ON TABLE people.cargos_exames IS 'Vínculo N:N entre cargos e exames exigidos. Informativo apenas.';
