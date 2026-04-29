-- =====================================================
-- 044 — Override de permissões por cargo
-- =====================================================
-- Resolve o caso em que dois cargos do mesmo nível precisam de
-- permissões diferentes (ex: Recrutador vs Analista DP, ambos Nível 2).
--
-- Modelo:
--   - Nível do cargo dá a base de permissões (via nivel_acesso_permissoes).
--   - Cada cargo pode ter um conjunto de OVERRIDES: marcar uma permissão
--     extra que não vinha do nível, ou remover uma permissão que vinha.
--
-- Tabela:
--   cargo_permissoes_override (cargo_id, permissao_id, concedido)
--   - concedido = TRUE  → ADICIONA a permissão (mesmo se nível não dá)
--   - concedido = FALSE → REMOVE a permissão (mesmo se nível dá)
--   - Sem linha     → herda do nível como antes
--
-- Permissão efetiva = (do nível) ∪ (overrides TRUE) − (overrides FALSE)
--
-- Idempotente.
-- =====================================================

CREATE TABLE IF NOT EXISTS people.cargo_permissoes_override (
    cargo_id        INTEGER NOT NULL REFERENCES people.cargos(id) ON DELETE CASCADE,
    permissao_id    INTEGER NOT NULL REFERENCES people.permissoes(id) ON DELETE CASCADE,
    concedido       BOOLEAN NOT NULL,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por  INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    PRIMARY KEY (cargo_id, permissao_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_cargo_perm_override_cargo
  ON people.cargo_permissoes_override(cargo_id);
CREATE INDEX IF NOT EXISTS idx_bt_cargo_perm_override_permissao
  ON people.cargo_permissoes_override(permissao_id);

-- Trigger de timestamp (mesma função usada nas outras tabelas).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_cargo_perm_override_atualizado_em'
    ) THEN
        CREATE TRIGGER tr_cargo_perm_override_atualizado_em
        BEFORE UPDATE ON people.cargo_permissoes_override
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;
