-- =====================================================
-- 042 — Escopo de gestão: departamentos e empresas que
--       cada gestor/líder enxerga.
-- =====================================================
-- Substitui semanticamente `liderancas_departamento` (que
-- cravava arrays separados por tipo: supervisor/coordenador/
-- gerente — frágil pra refatoração de hierarquia em níveis).
--
-- Modelo novo:
--   gestor_departamentos (colaborador_id, departamento_id) — N:N
--   gestor_empresas      (colaborador_id, empresa_id)      — N:N
--
-- Semântica:
--  - Quem está em `gestor_empresas` para empresa X gerencia
--    TODOS os colaboradores com `empresa_id = X` (independente
--    do departamento).
--  - Quem está em `gestor_departamentos` para dept Y gerencia
--    TODOS os colaboradores com `departamento_id = Y` (em
--    qualquer empresa).
--  - As duas regras são ADITIVAS — gestor herda escopo das
--    duas tabelas.
--  - Um colaborador continua sendo "gestor natural" do próprio
--    `departamento_id` (regra implícita aplicada no código).
--
-- Independente do nível: a tabela só define ONDE; o nível
-- (cargos.nivel_acesso_id) define O QUE pode fazer.
--
-- Idempotente.
-- =====================================================

SET search_path TO people;

CREATE TABLE IF NOT EXISTS people.gestor_departamentos (
    colaborador_id   INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    departamento_id  INTEGER NOT NULL REFERENCES people.departamentos(id) ON DELETE CASCADE,
    criado_em        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    criado_por       INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    PRIMARY KEY (colaborador_id, departamento_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_gestor_departamentos_colab
  ON people.gestor_departamentos(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_bt_gestor_departamentos_dept
  ON people.gestor_departamentos(departamento_id);

CREATE TABLE IF NOT EXISTS people.gestor_empresas (
    colaborador_id   INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    empresa_id       INTEGER NOT NULL REFERENCES people.empresas(id) ON DELETE CASCADE,
    criado_em        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    criado_por       INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    PRIMARY KEY (colaborador_id, empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_gestor_empresas_colab
  ON people.gestor_empresas(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_bt_gestor_empresas_empresa
  ON people.gestor_empresas(empresa_id);

-- liderancas_departamento permanece intacta nesta migration —
-- como confirmamos que está vazia em produção, fica disponível
-- pra remoção em uma migration futura junto com a Fase 4 da
-- refatoração de hierarquia (drop colaboradores.tipo etc.).
