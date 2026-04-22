-- Migration: 013_clinicas_agendamento
-- Campos de agendamento em clinicas + colunas dedicadas de ASO em solicitacoes_admissao

-- ── Clínicas ─────────────────────────────────────────────────────────────────

ALTER TABLE people.clinicas
  ADD COLUMN IF NOT EXISTS canal_agendamento       VARCHAR(20)
    CHECK (canal_agendamento IN ('whatsapp', 'site')),
  ADD COLUMN IF NOT EXISTS precisa_confirmacao     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_numero         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS site_agendamento_url    TEXT,
  ADD COLUMN IF NOT EXISTS observacoes_agendamento TEXT,
  ADD COLUMN IF NOT EXISTS horario_atendimento     JSONB;

COMMENT ON COLUMN people.clinicas.canal_agendamento       IS 'Como o agendamento é feito: whatsapp | site';
COMMENT ON COLUMN people.clinicas.precisa_confirmacao     IS 'true = DP confirma manualmente; false = ordem de chegada (backend avisa clínica via WhatsApp automaticamente). canal=site sempre true.';
COMMENT ON COLUMN people.clinicas.whatsapp_numero         IS 'Número WhatsApp com DDI, só dígitos (ex: 5562999998888). Obrigatório quando canal=whatsapp';
COMMENT ON COLUMN people.clinicas.site_agendamento_url    IS 'URL do site de agendamento. Obrigatório quando canal=site';
COMMENT ON COLUMN people.clinicas.observacoes_agendamento IS 'Texto livre exibido ao DP no momento do agendamento';
COMMENT ON COLUMN people.clinicas.horario_atendimento     IS 'JSONB: { seg: { aberto, abre, fecha }, ter: {...}, ... }';

-- ── Solicitações de admissão ─────────────────────────────────────────────────
-- Remove coluna genérica agendamento_aso (substituída por colunas dedicadas)

ALTER TABLE people.solicitacoes_admissao
  DROP COLUMN IF EXISTS agendamento_aso,
  ADD COLUMN IF NOT EXISTS clinica_id        INTEGER REFERENCES people.clinicas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_exame_aso    DATE,
  ADD COLUMN IF NOT EXISTS mensagem_aso      TEXT,
  ADD COLUMN IF NOT EXISTS aso_solicitado_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_solicitacoes_admissao_clinica ON people.solicitacoes_admissao (clinica_id);

COMMENT ON COLUMN people.solicitacoes_admissao.clinica_id        IS 'Clínica vinculada ao exame admissional';
COMMENT ON COLUMN people.solicitacoes_admissao.data_exame_aso    IS 'Data agendada para o exame';
COMMENT ON COLUMN people.solicitacoes_admissao.mensagem_aso      IS 'Mensagem formatada enviada ao candidato no agendamento';
COMMENT ON COLUMN people.solicitacoes_admissao.aso_solicitado_em IS 'Timestamp de quando o ASO foi solicitado';
