-- Migration: 005_clinicas
-- Tabela de clínicas para exames admissionais, vinculadas a filiais (localizacoes)

CREATE TABLE IF NOT EXISTS people.clinicas (
  id            SERIAL PRIMARY KEY,
  nome          VARCHAR(255) NOT NULL,
  telefone      VARCHAR(20),
  cep           VARCHAR(10),
  logradouro    VARCHAR(255),
  numero        VARCHAR(20),
  complemento   VARCHAR(100),
  bairro        VARCHAR(100),
  cidade        VARCHAR(100),
  estado        VARCHAR(2),
  status        VARCHAR(20) NOT NULL DEFAULT 'ativa'
                  CHECK (status IN ('ativa', 'inativa')),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabela de vínculo clínica ↔ filial (localizacao)
-- Uma filial pode ter N clínicas; uma clínica pode atender N filiais
CREATE TABLE IF NOT EXISTS people.clinica_filial (
  id             SERIAL PRIMARY KEY,
  clinica_id     INTEGER NOT NULL REFERENCES people.clinicas(id) ON DELETE CASCADE,
  localizacao_id INTEGER NOT NULL REFERENCES people.localizacoes(id) ON DELETE CASCADE,
  UNIQUE (clinica_id, localizacao_id)
);

-- Trigger de atualizado_em
CREATE OR REPLACE FUNCTION people.set_atualizado_em_clinicas()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clinicas_atualizado_em
  BEFORE UPDATE ON people.clinicas
  FOR EACH ROW EXECUTE FUNCTION people.set_atualizado_em_clinicas();

-- Índices
CREATE INDEX IF NOT EXISTS idx_clinicas_status       ON people.clinicas (status);
CREATE INDEX IF NOT EXISTS idx_clinicas_cidade       ON people.clinicas (cidade);
CREATE INDEX IF NOT EXISTS idx_clinica_filial_clinica ON people.clinica_filial (clinica_id);
CREATE INDEX IF NOT EXISTS idx_clinica_filial_local  ON people.clinica_filial (localizacao_id);

COMMENT ON TABLE  people.clinicas               IS 'Clínicas credenciadas para realização de exames admissionais';
COMMENT ON TABLE  people.clinica_filial         IS 'Vínculo entre clínicas e filiais (localizacoes) que as disponibilizam para seus colaboradores';
COMMENT ON COLUMN people.clinicas.status        IS 'ativa = disponível para uso; inativa = desabilitada';
