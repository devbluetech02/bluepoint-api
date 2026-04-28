-- Migration: 043_cargos_salario_cbo_jornada_uf
-- Parametriza salário, CBO e jornada por cargo, com sobrescrita opcional por UF.
--
-- Modelo:
-- - cargos.cbo, cargos.salario_padrao, cargos.jornada_id_padrao
--   guardam os valores nacionais (CBO é federal, não varia por UF).
-- - people.cargos_uf é sparse: só tem linha para UFs que divergem do padrão.
-- - Lookup efetivo: COALESCE(cargos_uf.X, cargos.X_padrao) usando a UF
--   da empresa do colaborador (people.empresas.estado).

BEGIN;

-- 1) Campos nacionais no próprio cargo
ALTER TABLE people.cargos
  ADD COLUMN IF NOT EXISTS cbo               VARCHAR(7),
  ADD COLUMN IF NOT EXISTS salario_padrao    NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS jornada_id_padrao INTEGER REFERENCES people.jornadas(id) ON DELETE SET NULL;

COMMENT ON COLUMN people.cargos.cbo IS
  'Código CBO 2002 (classificação federal, não varia por UF). 6 dígitos sem máscara.';
COMMENT ON COLUMN people.cargos.salario_padrao IS
  'Salário-base nacional. Sobrescrito por UF em people.cargos_uf quando aplicável.';
COMMENT ON COLUMN people.cargos.jornada_id_padrao IS
  'Jornada padrão nacional. Sobrescrita por UF em people.cargos_uf quando aplicável.';

-- 2) Sobrescritas regionais (sparse — só UFs que divergem do padrão)
CREATE TABLE IF NOT EXISTS people.cargos_uf (
  cargo_id      INTEGER       NOT NULL REFERENCES people.cargos(id) ON DELETE CASCADE,
  uf            VARCHAR(2)    NOT NULL,
  salario       NUMERIC(10, 2),
  jornada_id    INTEGER       REFERENCES people.jornadas(id) ON DELETE SET NULL,
  criado_em     TIMESTAMP     NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cargo_id, uf),
  CONSTRAINT ck_cargos_uf_valida CHECK (uf IN (
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
    'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
  )),
  CONSTRAINT ck_cargos_uf_tem_override CHECK (
    salario IS NOT NULL OR jornada_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_cargos_uf_cargo ON people.cargos_uf(cargo_id);

DROP TRIGGER IF EXISTS trg_cargos_uf_atualizado_em ON people.cargos_uf;
CREATE TRIGGER trg_cargos_uf_atualizado_em
  BEFORE UPDATE ON people.cargos_uf
  FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

COMMENT ON TABLE people.cargos_uf IS
  'Sobrescritas regionais (por UF da empresa) de salário/jornada por cargo. Sparse: só registros para UFs que divergem do padrão em people.cargos.';

COMMIT;
