-- =====================================================
-- 045 — Atualização Cadastral
-- =====================================================
-- Estrutura para solicitar atualização de dados de
-- colaboradores via formulário público (sem login).
-- Segue o mesmo padrão de formularios_admissao.
-- Idempotente (pode rodar várias vezes).
-- =====================================================

SET search_path TO people;

-- 1. Template do formulário (configurável em Settings)
CREATE TABLE IF NOT EXISTS people.formularios_atualizacao_cadastral (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    titulo          VARCHAR(255) NOT NULL DEFAULT 'Atualização Cadastral',
    descricao       TEXT,
    campos          JSONB NOT NULL DEFAULT '[]'::jsonb,
    documentos_requeridos JSONB NOT NULL DEFAULT '[]'::jsonb,
    ativo           BOOLEAN NOT NULL DEFAULT true,
    criado_em       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_form_atualizacao_cadastral_ts'
    ) THEN
        CREATE TRIGGER trg_form_atualizacao_cadastral_ts
        BEFORE UPDATE ON people.formularios_atualizacao_cadastral
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;

-- 2. Solicitações individuais (uma por colaborador/pedido)
CREATE TABLE IF NOT EXISTS people.solicitacoes_atualizacao_cadastral (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    formulario_id           UUID NOT NULL REFERENCES people.formularios_atualizacao_cadastral(id),
    colaborador_id          INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    solicitante_id          INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    token_publico           VARCHAR(64) NOT NULL UNIQUE,
    campos_selecionados     JSONB NOT NULL DEFAULT '[]'::jsonb,
    documentos_selecionados JSONB NOT NULL DEFAULT '[]'::jsonb,
    dados_resposta          JSONB,
    documentos_resposta     JSONB,
    status                  VARCHAR(30) NOT NULL DEFAULT 'pendente'
        CHECK (status IN ('pendente', 'enviado', 'respondido', 'aplicado', 'expirado', 'cancelado')),
    whatsapp_enviado        BOOLEAN NOT NULL DEFAULT false,
    mensagem_whatsapp       TEXT,
    respondido_em           TIMESTAMP,
    expira_em               TIMESTAMP,
    criado_em               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sol_atualiz_token
    ON people.solicitacoes_atualizacao_cadastral(token_publico);
CREATE INDEX IF NOT EXISTS idx_sol_atualiz_colab
    ON people.solicitacoes_atualizacao_cadastral(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_sol_atualiz_status
    ON people.solicitacoes_atualizacao_cadastral(status)
    WHERE status IN ('pendente', 'enviado');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_sol_atualizacao_cadastral_ts'
    ) THEN
        CREATE TRIGGER trg_sol_atualizacao_cadastral_ts
        BEFORE UPDATE ON people.solicitacoes_atualizacao_cadastral
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;
