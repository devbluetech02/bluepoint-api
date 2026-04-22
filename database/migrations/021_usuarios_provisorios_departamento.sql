-- Migration: 021_usuarios_provisorios_departamento
-- Adiciona departamento_id ao usuário provisório para pré-preencher
-- o formulário de admissão com o departamento correto.

ALTER TABLE people.usuarios_provisorios
  ADD COLUMN IF NOT EXISTS departamento_id INTEGER REFERENCES people.departamentos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_departamento ON people.usuarios_provisorios (departamento_id);

COMMENT ON COLUMN people.usuarios_provisorios.departamento_id IS 'Departamento do candidato — usado para pré-preencher o formulário de admissão';
