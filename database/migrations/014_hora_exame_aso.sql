-- Migration: 014_hora_exame_aso
-- Adiciona hora exata do exame ASO para calcular lembretes precisos (1h, 24h, 36h, 48h)

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS hora_exame_aso TIME;

COMMENT ON COLUMN people.solicitacoes_admissao.hora_exame_aso IS 'Hora agendada para o exame ASO (HH:MM). Combinada com data_exame_aso forma o timestamp exato do exame.';
