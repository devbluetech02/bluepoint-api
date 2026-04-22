-- Migration: 005_remove_empresa_usuarios_provisorios
-- Remove coluna empresa_id da tabela usuarios_provisorios

ALTER TABLE people.usuarios_provisorios DROP COLUMN IF EXISTS empresa_id;
DROP INDEX IF EXISTS people.idx_usuarios_provisorios_empresa;
