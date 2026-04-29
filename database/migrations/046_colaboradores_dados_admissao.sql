-- =====================================================
-- 046 — Colaboradores: persistência completa dos dados
--       coletados na pré-admissão
-- =====================================================
-- Hoje a tabela `colaboradores` tem só os campos básicos (CPF, RG,
-- endereço, vales). Os 29 campos do formulário default de pré-admissão
-- (estado civil, formação, cor/raça, dados bancários, biometria física,
-- contato de emergência, etc.) ficam apenas no JSONB `dados` da
-- solicitação e não são persistidos no colaborador na admissão.
--
-- Esta migration adiciona as colunas faltantes para que TODOS os dados
-- da pré-admissão fiquem persistidos no colaborador. Idempotente.
-- =====================================================

SET search_path TO people;

ALTER TABLE people.colaboradores
    ADD COLUMN IF NOT EXISTS rg_orgao_emissor             VARCHAR(20),
    ADD COLUMN IF NOT EXISTS rg_uf                        VARCHAR(2),
    ADD COLUMN IF NOT EXISTS estado_civil                 VARCHAR(40),
    ADD COLUMN IF NOT EXISTS formacao                     VARCHAR(120),
    ADD COLUMN IF NOT EXISTS cor_raca                     VARCHAR(20),
    ADD COLUMN IF NOT EXISTS banco_nome                   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS banco_tipo_conta             VARCHAR(30),
    ADD COLUMN IF NOT EXISTS banco_agencia                VARCHAR(20),
    ADD COLUMN IF NOT EXISTS banco_conta                  VARCHAR(30),
    ADD COLUMN IF NOT EXISTS pix_tipo                     VARCHAR(20),
    ADD COLUMN IF NOT EXISTS pix_chave                    VARCHAR(120),
    ADD COLUMN IF NOT EXISTS auxilio_combustivel          BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS uniforme_tamanho             VARCHAR(10),
    ADD COLUMN IF NOT EXISTS altura_metros                NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS peso_kg                      NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS contato_emergencia_nome      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS contato_emergencia_telefone  VARCHAR(20);

COMMENT ON COLUMN people.colaboradores.rg_orgao_emissor             IS 'Órgão emissor do RG (ex.: SSP, DETRAN). Coletado no formulário de admissão.';
COMMENT ON COLUMN people.colaboradores.rg_uf                        IS 'UF emissora do RG (sigla de 2 letras).';
COMMENT ON COLUMN people.colaboradores.estado_civil                 IS 'Solteiro, Casado, União estável (com registro), Divorciado, Viúvo.';
COMMENT ON COLUMN people.colaboradores.formacao                     IS 'Escolaridade conforme tabela eSocial (analfabeto até pós-doutorado).';
COMMENT ON COLUMN people.colaboradores.cor_raca                     IS 'Indígena, Branca, Preta, Amarela, Parda.';
COMMENT ON COLUMN people.colaboradores.banco_nome                   IS 'Nome do banco para depósito de salário.';
COMMENT ON COLUMN people.colaboradores.banco_tipo_conta             IS 'Conta Salário, Conta Corrente, Conta Poupança.';
COMMENT ON COLUMN people.colaboradores.banco_agencia                IS 'Agência com dígito (ex.: 0001-0).';
COMMENT ON COLUMN people.colaboradores.banco_conta                  IS 'Conta com dígito (ex.: 0056868-0).';
COMMENT ON COLUMN people.colaboradores.pix_tipo                     IS 'Telefone, Email ou CPF.';
COMMENT ON COLUMN people.colaboradores.pix_chave                    IS 'Chave PIX do mesmo banco informado em banco_nome.';
COMMENT ON COLUMN people.colaboradores.auxilio_combustivel          IS 'Mutuamente exclusivo com vale_transporte — só um deles deve ser true.';
COMMENT ON COLUMN people.colaboradores.uniforme_tamanho             IS 'P, M, G, GG, XGG.';
COMMENT ON COLUMN people.colaboradores.altura_metros                IS 'Altura em metros (ex.: 1.75).';
COMMENT ON COLUMN people.colaboradores.peso_kg                      IS 'Peso em quilos (ex.: 78.50).';
COMMENT ON COLUMN people.colaboradores.contato_emergencia_nome      IS 'Nome do contato em caso de emergência.';
COMMENT ON COLUMN people.colaboradores.contato_emergencia_telefone  IS 'Telefone do contato em caso de emergência (apenas dígitos).';
