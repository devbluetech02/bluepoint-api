-- Migration: 032_parametros_admissao_contrato
-- Adiciona em people.parametros_rh os parâmetros de defaults de contrato
-- usados pelo _AdmissaoContratoDialog no envio de contrato (FLUXO_RECRUTAMENTO §4).
--
-- - dias_uteis_data_admissao: offset em dias úteis a partir do envio pra
--   calcular a data de admissão default. Feriados nacionais são consultados
--   no front (BrasilAPI); DP pode ajustar manualmente se cair em feriado
--   municipal.
-- - vigencia_confidencialidade_meses: vigência padrão de {{VIGENCIA}} em
--   termos de confidencialidade.
-- - aplicar_beneficios_em_dia_teste: se vale transporte/alimentação/combustível
--   são devidos também nos dias de teste.
--
-- Idempotente: IF NOT EXISTS.

BEGIN;

ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS dias_uteis_data_admissao         INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS vigencia_confidencialidade_meses INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS aplicar_beneficios_em_dia_teste  BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN people.parametros_rh.dias_uteis_data_admissao IS
  'Offset em dias úteis a partir da data de envio do contrato para calcular a data de admissão default.';
COMMENT ON COLUMN people.parametros_rh.vigencia_confidencialidade_meses IS
  'Vigência padrão (em meses) usada no preenchimento automático de {{VIGENCIA}} / {{VIGENCIA_CONFIDENCIALIDADE}}.';
COMMENT ON COLUMN people.parametros_rh.aplicar_beneficios_em_dia_teste IS
  'Se true, vale transporte/alimentação/combustível são devidos nos dias de teste — consumido pelo fluxo de recrutamento.';

COMMIT;
