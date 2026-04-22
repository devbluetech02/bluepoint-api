-- =====================================================
-- MIGRAÇÃO: Tabela de preferências de notificações
--
-- Permite que cada colaborador personalize quais
-- notificações push deseja receber.
--
-- Tipos suportados:
--   solicitacao_aprovada   – quando uma solicitação é aprovada
--   solicitacao_rejeitada  – quando uma solicitação é rejeitada
--   atraso_registrado      – quando registra entrada com atraso
--   esportes_hoje          – lembrete de sessão de futebol no dia
--   relatorio_disponivel   – relatório de ponto disponível para assinatura
--
-- Por padrão (sem linha na tabela) = notificação ATIVA.
-- Para desativar, inserir com ativo = false.
-- =====================================================

CREATE TABLE IF NOT EXISTS people.parametros_notificacoes (
    id             SERIAL PRIMARY KEY,
    colaborador_id INTEGER      NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    tipo           VARCHAR(60)  NOT NULL,
    ativo          BOOLEAN      NOT NULL DEFAULT true,
    criado_em      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (colaborador_id, tipo)
);

CREATE INDEX IF NOT EXISTS idx_parametros_notificacoes_colaborador
    ON people.parametros_notificacoes (colaborador_id);

COMMENT ON TABLE people.parametros_notificacoes IS
    'Preferências de notificações push por colaborador. Ausência de linha = notificação ativa.';

COMMENT ON COLUMN people.parametros_notificacoes.tipo IS
    'Identificador do tipo de notificação: solicitacao_aprovada, solicitacao_rejeitada, atraso_registrado, esportes_hoje, relatorio_disponivel';

COMMENT ON COLUMN people.parametros_notificacoes.ativo IS
    'true = receber notificação (default); false = não receber';
