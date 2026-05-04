-- Migration: 049_dia_teste_observacao_decisao
-- Adiciona observacao/motivo da decisão (aprovar/reprovar/desistencia) em
-- dia_teste_agendamento para exibição na lista do gestor no mobile.
-- Antes só existia no audit log (dadosNovos JSON), inviável pra UI.
--
-- Idempotente.

BEGIN;

ALTER TABLE people.dia_teste_agendamento
  ADD COLUMN IF NOT EXISTS observacao_decisao TEXT;

COMMENT ON COLUMN people.dia_teste_agendamento.observacao_decisao IS
  'Texto livre da decisão do gestor: observação ao aprovar, motivo ao reprovar/desistir. NULL pré-decisão ou quando o gestor não informou.';

COMMIT;
