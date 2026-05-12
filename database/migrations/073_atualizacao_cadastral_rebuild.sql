-- =====================================================
-- 073 — Atualização Cadastral: rebuild
-- =====================================================
-- O fluxo antigo dependia de um "form builder" no
-- Settings > Parâmetros que montava um TEMPLATE de campos
-- (people.formularios_atualizacao_cadastral) e as solicitações
-- referenciavam esse template.
--
-- O novo fluxo elimina o form builder: o gestor seleciona os
-- campos a atualizar direto do modal de detalhes do colaborador
-- (lista de campos é fixa no front, espelha o modal). A
-- solicitação carrega a própria lista de campos + tipos de
-- documento solicitados.
--
-- Esta migration:
--   1. Dropa `formularios_atualizacao_cadastral` (não usada mais).
--   2. Dropa e recria `solicitacoes_atualizacao_cadastral` com
--      schema novo dedicado ao fluxo direto.
--
-- Idempotente: usa DROP IF EXISTS + CREATE TABLE IF NOT EXISTS.
-- =====================================================

BEGIN;

-- 1. Drop tabela antiga do form builder e tabela antiga de solicitações.
--    CASCADE pra remover quaisquer FKs/views/triggers dependentes.
DROP TABLE IF EXISTS people.solicitacoes_atualizacao_cadastral CASCADE;
DROP TABLE IF EXISTS people.formularios_atualizacao_cadastral CASCADE;

-- 2. Nova tabela de solicitações.
CREATE TABLE IF NOT EXISTS people.solicitacoes_atualizacao_cadastral (
  id                  BIGSERIAL    PRIMARY KEY,
  colaborador_id      INTEGER      NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
  -- Token público (hex/uuid) usado no link
  -- https://people.valerisapp.com.br/?page=atualizacao&token=...
  token               TEXT         NOT NULL UNIQUE,
  -- Lista de campos solicitados — keys do modal de detalhes
  -- (ex.: ["nome","email","endereco_cep","banco_agencia",...]).
  -- O front mantém o mapeamento key → label/widget; o back não
  -- valida cada key, só persiste e devolve.
  campos_solicitados  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- IDs em people.tipos_documento_colaborador a anexar.
  tipos_documento_ids INTEGER[]    NOT NULL DEFAULT '{}',
  -- Mensagem WhatsApp customizada (opcional). Quando NULL usa
  -- template padrão na hora do envio.
  mensagem_whatsapp   TEXT,
  status              VARCHAR(20)  NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','enviado','respondido','aplicado','cancelado')),
  -- Snapshot dos dados que o colaborador respondeu (key → value).
  -- Pode incluir storage keys de docs uploaded também.
  dados_respondidos   JSONB,
  respondido_em       TIMESTAMPTZ,
  -- Quem disparou a solicitação (gestor/admin).
  criado_por          INTEGER      REFERENCES people.colaboradores(id) ON DELETE SET NULL,
  criado_em           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_solic_atual_cad_colaborador
  ON people.solicitacoes_atualizacao_cadastral(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_solic_atual_cad_status
  ON people.solicitacoes_atualizacao_cadastral(status);
CREATE INDEX IF NOT EXISTS idx_solic_atual_cad_token
  ON people.solicitacoes_atualizacao_cadastral(token);

CREATE TRIGGER tr_solic_atual_cad_atualizado_em
  BEFORE UPDATE ON people.solicitacoes_atualizacao_cadastral
  FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

COMMENT ON TABLE people.solicitacoes_atualizacao_cadastral IS
  'Solicitação enviada ao colaborador pra atualizar campos cadastrais e/ou anexar documentos. Fluxo direto (sem form builder).';
COMMENT ON COLUMN people.solicitacoes_atualizacao_cadastral.campos_solicitados IS
  'Lista JSON de keys de campos do modal de detalhes do colaborador (ex.: "nome", "endereco_cep").';
COMMENT ON COLUMN people.solicitacoes_atualizacao_cadastral.tipos_documento_ids IS
  'IDs em people.tipos_documento_colaborador que o colaborador deve anexar.';
COMMENT ON COLUMN people.solicitacoes_atualizacao_cadastral.dados_respondidos IS
  'JSON com as respostas: key → value. Pode incluir storage keys de docs uploaded.';

COMMIT;
