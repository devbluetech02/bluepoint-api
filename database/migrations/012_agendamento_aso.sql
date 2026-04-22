-- Migration: 012_agendamento_aso
-- Armazena dados do agendamento do exame admissional (ASO) na solicitação

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS agendamento_aso JSONB;

COMMENT ON COLUMN people.solicitacoes_admissao.agendamento_aso IS 'Dados do agendamento do ASO: { clinicaId, dataExame, mensagemAso }';
