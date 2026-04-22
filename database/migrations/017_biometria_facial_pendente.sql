-- Migration: 017_biometria_facial_pendente
-- Adiciona suporte a foto de perfil e biometria facial no formulário público de pré-admissão.
-- Candidatos ainda sem colaboradorId (token provisório) podem enviar foto e biometria
-- vinculadas à sua solicitacao_admissao antes de serem efetivamente admitidos.

-- 1. Adiciona coluna foto_perfil_url em solicitacoes_admissao
ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS foto_perfil_url TEXT;

COMMENT ON COLUMN people.solicitacoes_admissao.foto_perfil_url IS
  'URL da foto de perfil enviada pelo candidato durante a pré-admissão (MinIO). '
  'Copiada para colaborador.foto_url no momento da admissão.';

-- 2. Cria tabela para templates biométricos pendentes (antes da admissão)
CREATE TABLE IF NOT EXISTS people.biometria_facial_pendente (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitacao_id      UUID        NOT NULL
                                  REFERENCES people.solicitacoes_admissao(id)
                                  ON DELETE CASCADE,
  template            BYTEA       NOT NULL,            -- mesmo formato de biometria_facial.encoding (ArcFace 512-d)
  foto_referencia_url TEXT        NOT NULL,            -- MinIO: frame de maior qualidade
  qualidade           NUMERIC,                         -- score de qualidade 0-1 do melhor frame
  frames_urls         TEXT[],                          -- todos os frames brutos (auditoria)
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (solicitacao_id)
);

COMMENT ON TABLE people.biometria_facial_pendente IS
  'Templates biométricos de candidatos em pré-admissão. '
  'Gerados pela mesma engine InsightFace/ArcFace de biometria_facial. '
  'Migrados para biometria_facial e deletados no momento em que o candidato é admitido.';
