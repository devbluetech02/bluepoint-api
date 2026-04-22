-- Migration: 011_clinicas_empresa
-- Substitui vínculo clinica↔localizacao (filial) por clinica↔empresa direto

-- Remove tabela de vínculo antiga
DROP TABLE IF EXISTS people.clinica_filial;

-- Adiciona empresa_id direto na tabela de clínicas
ALTER TABLE people.clinicas
  ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES people.empresas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clinicas_empresa ON people.clinicas (empresa_id);

COMMENT ON COLUMN people.clinicas.empresa_id IS 'Empresa a qual a clínica está vinculada';
