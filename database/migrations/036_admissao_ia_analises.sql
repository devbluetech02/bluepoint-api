-- Migration: 036_admissao_ia_analises
-- Histórico das análises feitas pela IA (OpenRouter) sobre solicitações
-- de pré-admissão. Cada clique no botão "Analisar com IA" gera 1 registro.
--
-- Usado pra:
--  - Auditoria (quem disparou, quando, com que modelo)
--  - Regra da 2ª correção: se a IA flaggar um campo/doc que já foi
--    flaggado numa análise anterior, força escalar_humano.
--  - Debug (raw_response guardada integralmente).

BEGIN;

CREATE TABLE IF NOT EXISTS people.admissao_ia_analises (
  id                    SERIAL PRIMARY KEY,
  solicitacao_id        UUID NOT NULL REFERENCES people.solicitacoes_admissao(id) ON DELETE CASCADE,
  disparado_por         BIGINT,
  disparado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modelo                TEXT NOT NULL,
  acao_decidida         TEXT NOT NULL,
  motivo                TEXT,
  campos_problema       JSONB NOT NULL DEFAULT '[]'::jsonb,
  documentos_problema   JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalado_por_regra    BOOLEAN NOT NULL DEFAULT false,
  prompt_tokens         INTEGER,
  completion_tokens     INTEGER,
  raw_response          JSONB,
  erro                  TEXT,
  CONSTRAINT admissao_ia_acao_check CHECK (acao_decidida IN (
    'solicitar_correcao',
    'ok_para_aso',
    'escalar_humano',
    'falha'
  ))
);

CREATE INDEX IF NOT EXISTS idx_admissao_ia_analises_sol
  ON people.admissao_ia_analises(solicitacao_id, disparado_em DESC);

COMMENT ON TABLE people.admissao_ia_analises IS
  'Histórico das análises automáticas de pré-admissão feitas pela IA (OpenRouter).';
COMMENT ON COLUMN people.admissao_ia_analises.acao_decidida IS
  'Ação que a IA decidiu: solicitar_correcao, ok_para_aso, escalar_humano, ou falha (erro de rede/parse).';
COMMENT ON COLUMN people.admissao_ia_analises.escalado_por_regra IS
  'TRUE quando a decisão original era solicitar_correcao mas o sistema forçou escalar_humano por regra da 2ª correção no mesmo item.';
COMMENT ON COLUMN people.admissao_ia_analises.raw_response IS
  'Response bruto da OpenRouter (content + usage) pra debug. Não usar em lógica de negócio.';

COMMIT;
