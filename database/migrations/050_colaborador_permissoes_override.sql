-- =====================================================
-- 050 — Override de permissões por colaborador (pessoa)
-- =====================================================
-- Casos especiais em que UMA pessoa específica precisa de uma permissão
-- diferente do que o cargo dela concede (ex: estagiário com permissão
-- extra de "aprovar atrasos pontualmente"; gerente que perdeu acesso
-- a relatórios financeiros).
--
-- Modelo idêntico ao cargo_permissoes_override (migration 044), só que
-- a chave é o colaborador.
--
-- Resolução final de permissão efetiva:
--   nivel ∪ cargo_overrides(true) ∪ colab_overrides(true)
--         − cargo_overrides(false) − colab_overrides(false)
--
-- Override de COLABORADOR tem precedência sobre o de CARGO. Ou seja:
-- se cargo_override remove e colab_override concede → concedido.
--
-- Reset automático: trigger limpa todas as linhas do colaborador quando
-- o cargo dele muda. Evita "permissão fantasma" — overrides individuais
-- foram concedidos no contexto do cargo antigo e não devem persistir
-- automaticamente em um cargo novo.
--
-- Idempotente.
-- =====================================================

CREATE TABLE IF NOT EXISTS people.colaborador_permissoes_override (
    colaborador_id  INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    permissao_id    INTEGER NOT NULL REFERENCES people.permissoes(id) ON DELETE CASCADE,
    concedido       BOOLEAN NOT NULL,
    motivo          TEXT,
    criado_em       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por  INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    PRIMARY KEY (colaborador_id, permissao_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_colab_perm_override_colab
  ON people.colaborador_permissoes_override(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_bt_colab_perm_override_permissao
  ON people.colaborador_permissoes_override(permissao_id);

-- Trigger de atualizado_em (reusa função padrão).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_colab_perm_override_atualizado_em'
    ) THEN
        CREATE TRIGGER tr_colab_perm_override_atualizado_em
        BEFORE UPDATE ON people.colaborador_permissoes_override
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;

-- =====================================================
-- Reset automático ao mudar cargo
-- =====================================================
-- Função: limpa overrides individuais quando cargo_id muda.
CREATE OR REPLACE FUNCTION people.reset_colab_perm_override_on_cargo_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.cargo_id IS DISTINCT FROM OLD.cargo_id THEN
        DELETE FROM people.colaborador_permissoes_override
         WHERE colaborador_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_reset_colab_perm_override_on_cargo_change'
    ) THEN
        CREATE TRIGGER tr_reset_colab_perm_override_on_cargo_change
        AFTER UPDATE OF cargo_id ON people.colaboradores
        FOR EACH ROW
        EXECUTE FUNCTION people.reset_colab_perm_override_on_cargo_change();
    END IF;
END$$;
