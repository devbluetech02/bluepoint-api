-- Migration: 044_cargos_rename_salario_medio_para_salario_padrao
-- Consolida as duas colunas de salário criadas pela migration 043.
--
-- Contexto: na 043 adicionei `cargos.salario_padrao` sem perceber que já
-- existia `cargos.salario_medio` ocupando exatamente esse papel (apesar
-- do nome enganoso). `salario_padrao` ficou vazio; `salario_medio` segue
-- com os dados reais e é referenciado pela API/web.
--
-- Decisão: dropar `salario_padrao` (vazio, sem consumidores) e renomear
-- `salario_medio` → `salario_padrao` para alinhar com o vocabulário
-- novo (cargos_uf.salario sobrescreve cargos.salario_padrao).
--
-- Idempotência: o bloco DO só executa o rename se a coluna velha ainda
-- existir, e o DROP é IF EXISTS — pode ser reaplicada sem erro.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'people'
       AND table_name   = 'cargos'
       AND column_name  = 'salario_medio'
  ) THEN
    ALTER TABLE people.cargos DROP COLUMN IF EXISTS salario_padrao;
    ALTER TABLE people.cargos RENAME COLUMN salario_medio TO salario_padrao;
  END IF;
END$$;

COMMENT ON COLUMN people.cargos.salario_padrao IS
  'Salário-base nacional do cargo. Sobrescrito por UF em people.cargos_uf quando aplicável. (renomeado de salario_medio em 044)';

COMMIT;
