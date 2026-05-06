-- 065_dia_teste_hora_inicio.sql
-- Adiciona horário de início programado ao agendamento do dia de teste.
-- Quando >= 12:00 o agendamento corresponde a 1 período (tarde, 4h carga);
-- < 12:00 corresponde a 2 períodos (manhã + tarde, 8h carga).
-- Default 08:00 para compatibilidade retroativa com registros existentes.

ALTER TABLE people.dia_teste_agendamento
  ADD COLUMN IF NOT EXISTS hora_inicio TIME NOT NULL DEFAULT '08:00';

COMMENT ON COLUMN people.dia_teste_agendamento.hora_inicio IS
  'Horário de início programado do agendamento. Default 08:00.';
