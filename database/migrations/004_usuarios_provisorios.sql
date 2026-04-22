-- Migration: 004_usuarios_provisorios
-- Tabela para usuários provisórios que autenticam apenas com CPF

CREATE TABLE IF NOT EXISTS people.usuarios_provisorios (
  id              SERIAL PRIMARY KEY,
  nome            VARCHAR(255) NOT NULL,
  cpf             VARCHAR(14)  NOT NULL UNIQUE,
  empresa_id      INTEGER REFERENCES people.empresas(id) ON DELETE SET NULL,
  status          VARCHAR(20)  NOT NULL DEFAULT 'ativo'
                    CHECK (status IN ('ativo', 'inativo')),
  expira_em       TIMESTAMPTZ,                          -- NULL = sem expiração
  observacao      TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por      INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atualiza atualizado_em automaticamente
CREATE OR REPLACE FUNCTION people.set_atualizado_em_usuarios_provisorios()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_usuarios_provisorios_atualizado_em
  BEFORE UPDATE ON people.usuarios_provisorios
  FOR EACH ROW EXECUTE FUNCTION people.set_atualizado_em_usuarios_provisorios();

-- Índices
CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_cpf     ON people.usuarios_provisorios (cpf);
CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_status  ON people.usuarios_provisorios (status);
CREATE INDEX IF NOT EXISTS idx_usuarios_provisorios_empresa ON people.usuarios_provisorios (empresa_id);

COMMENT ON TABLE  people.usuarios_provisorios          IS 'Usuários temporários que autenticam somente via CPF, com acesso restrito';
COMMENT ON COLUMN people.usuarios_provisorios.expira_em IS 'Data/hora de expiração do acesso; NULL significa sem expiração definida';
