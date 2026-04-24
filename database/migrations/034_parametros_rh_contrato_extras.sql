-- Migration: 034_parametros_rh_contrato_extras
-- Mais defaults globais consumidos pelo _AdmissaoContratoDialog ao montar
-- variáveis do contrato (aviso de férias, cláusulas CLT padrão da empresa).
--
-- - dias_ferias_padrao (30): default pra {{DIAS_FERIAS}}.
-- - abono_pecuniario_padrao (true): política padrão da empresa; alimenta
--   {{ABONO_PECUNIARIO}} com "Sim" ou "Não".
-- - adiantamento_13_padrao (true): idem pra {{ADIANTAMENTO_13}}.
--
-- Idempotente.

BEGIN;

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS dias_ferias_padrao       INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS abono_pecuniario_padrao  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS adiantamento_13_padrao   BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN people.parametros_rh.dias_ferias_padrao IS
  'Dias de férias default usado em {{DIAS_FERIAS}} nos templates de aviso de férias.';
COMMENT ON COLUMN people.parametros_rh.abono_pecuniario_padrao IS
  'Política padrão: concede abono pecuniário de 10 dias nas férias. Alimenta {{ABONO_PECUNIARIO}} com Sim/Não.';
COMMENT ON COLUMN people.parametros_rh.adiantamento_13_padrao IS
  'Política padrão: concede adiantamento de 50% do 13º no gozo das férias. Alimenta {{ADIANTAMENTO_13}} com Sim/Não.';

COMMIT;
