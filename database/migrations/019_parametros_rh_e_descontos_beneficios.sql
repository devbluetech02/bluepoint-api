-- =====================================================
-- MIGRAÇÃO 019: Parâmetros de RH + descontos por falta em Benefícios
--
-- 1) Cria tabela `people.parametros_rh` (singleton — apenas um
--    registro vigente com os parâmetros globais de RH da empresa).
--
-- 2) Adiciona em `people.parametros_beneficios` os campos de
--    desconto por falta para vale alimentação e vale combustível.
-- =====================================================

-- 1. Parâmetros globais de RH
CREATE TABLE IF NOT EXISTS people.parametros_rh (
    id                        SERIAL PRIMARY KEY,
    telefone_rh               VARCHAR(30)  NOT NULL DEFAULT '',
    email_rh                  VARCHAR(120) NOT NULL DEFAULT '',
    dias_experiencia_padrao   INTEGER      NOT NULL DEFAULT 0,
    dias_prorrogacao_padrao   INTEGER      NOT NULL DEFAULT 0,
    atualizado_em             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_por            INTEGER      REFERENCES people.colaboradores(id) ON DELETE SET NULL
);

COMMENT ON TABLE people.parametros_rh IS
    'Parâmetros globais de RH da empresa (contato, experiência/prorrogação). Apenas o registro mais recente é vigente.';

-- 2. Descontos por falta em parametros_beneficios
ALTER TABLE people.parametros_beneficios
    ADD COLUMN IF NOT EXISTS desconto_falta_alimentacao NUMERIC(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS desconto_falta_combustivel NUMERIC(10, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN people.parametros_beneficios.desconto_falta_alimentacao IS
    'Valor descontado do vale alimentação por dia de falta';
COMMENT ON COLUMN people.parametros_beneficios.desconto_falta_combustivel IS
    'Valor descontado do vale combustível por dia de falta';
