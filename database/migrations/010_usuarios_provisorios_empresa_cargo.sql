-- Migration: 010_usuarios_provisorios_empresa_cargo
-- Adiciona empresa_id e cargo_id ao usuário provisório para pré-preencher
-- o formulário de admissão com os documentos corretos sem seleção manual.

ALTER TABLE people.usuarios_provisorios
  ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES people.empresas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cargo_id   INTEGER REFERENCES people.cargos(id)   ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_empresa ON people.usuarios_provisorios (empresa_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_cargo   ON people.usuarios_provisorios (cargo_id);

COMMENT ON COLUMN people.usuarios_provisorios.empresa_id IS 'Filial/empresa do candidato — retornada no login para o app';
COMMENT ON COLUMN people.usuarios_provisorios.cargo_id   IS 'Cargo do candidato — usado para filtrar documentos requeridos no formulário';
