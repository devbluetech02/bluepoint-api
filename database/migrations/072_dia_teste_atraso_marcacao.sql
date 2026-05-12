-- Migration 072 — Indicador de atraso na marcação de comparecimento.
--
-- Adiciona 2 parâmetros globais em parametros_rh:
--   * dia_teste_hora_inicio_marcacao    (TIME, default '08:00')
--   * dia_teste_tolerancia_marcacao_minutos (INTEGER, default 60)
--
-- E uma coluna em dia_teste_agendamento:
--   * marcacao_atraso_minutos (INTEGER NULL) — minutos APÓS o prazo limite
--     no momento em que o gestor marcou compareceu/nao-compareceu.
--     NULL  = nunca marcado (status 'agendado' / 'cancelado')
--     <= 0  = marcou dentro do prazo
--     > 0   = atraso real (será exibido em modal pro gestor + indicador KPI)
--
-- Prazo limite = data_agendamento + hora_inicio_marcacao + tolerancia (BRT).
-- Aplicado nos endpoints POST /compareceu e /nao-compareceu.

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS dia_teste_hora_inicio_marcacao TIME NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS dia_teste_tolerancia_marcacao_minutos INTEGER NOT NULL DEFAULT 60;

-- Garantia: tolerância não pode ser negativa.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema = 'people'
       AND constraint_name = 'parametros_rh_dia_teste_tolerancia_marcacao_minutos_check'
  ) THEN
    ALTER TABLE people.parametros_rh
      ADD CONSTRAINT parametros_rh_dia_teste_tolerancia_marcacao_minutos_check
      CHECK (dia_teste_tolerancia_marcacao_minutos >= 0);
  END IF;
END$$;

ALTER TABLE people.dia_teste_agendamento
  ADD COLUMN IF NOT EXISTS marcacao_atraso_minutos INTEGER NULL;

COMMENT ON COLUMN people.dia_teste_agendamento.marcacao_atraso_minutos IS
  'Minutos depois do prazo limite (data + hora_inicio_marcacao + tolerancia) '
  'no momento em que o gestor marcou compareceu/nao-compareceu. NULL = não '
  'marcado ainda. > 0 = atraso real (indicador). <= 0 = dentro do prazo.';
