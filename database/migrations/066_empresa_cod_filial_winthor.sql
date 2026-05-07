-- =====================================================
-- MIGRAÇÃO 066: Código da filial no Winthor por empresa
--
-- Adiciona em people.empresas:
--   - cod_filial_winthor INTEGER NULL : número da filial correspondente
--     no ERP Winthor (WINDOW.PCLANC.CODFILIAL).
--
-- Usado pela integração que lança pagamentos PIX de candidatos em dia
-- de teste como "Conta a Pagar" no Winthor. Sem este preenchido por
-- empresa, o lançamento cai num default (Ethos = 17) ou é pulado.
-- =====================================================

ALTER TABLE people.empresas
  ADD COLUMN IF NOT EXISTS cod_filial_winthor INTEGER;

COMMENT ON COLUMN people.empresas.cod_filial_winthor IS
  'Código da filial no ERP Winthor (WINDOW.PCLANC.CODFILIAL). '
  'Usado pela integração de lançamento contábil dos pagamentos PIX '
  'de dia de teste. Preencher pelo site (Cadastros → Empresas).';
