-- =====================================================
-- MIGRAÇÃO 060: Relaxa CHECK de ordem em dia_teste_agendamento
--
-- Antes: ordem entre 1 e 2 (máx 2 dias por processo).
-- Agora: ordem >= 1 (sem teto), pra suportar fluxo "aprovar e adicionar
-- mais 1 dia" — gestor pode pedir N dias extras conforme avalia.
-- =====================================================

ALTER TABLE people.dia_teste_agendamento
  DROP CONSTRAINT IF EXISTS dia_teste_agendamento_ordem_check;

ALTER TABLE people.dia_teste_agendamento
  ADD CONSTRAINT dia_teste_agendamento_ordem_check
  CHECK (ordem >= 1);
