-- Migration: 015_clinicas_pix
-- Adiciona chave PIX à tabela de clínicas

ALTER TABLE people.clinicas
  ADD COLUMN IF NOT EXISTS pix VARCHAR(255);

COMMENT ON COLUMN people.clinicas.pix IS 'Chave PIX da clínica (CPF, CNPJ, e-mail, telefone ou chave aleatória)';
