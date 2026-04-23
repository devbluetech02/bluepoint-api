-- Migration: 029_usuarios_provisorios_dias_teste
-- Adiciona dias_teste em usuarios_provisorios.
-- Conceito migrado de "atributo do cargo" para "decisão por candidato no momento
-- do acesso provisório". Valor é opcional; NULL = sem teste remunerado.
-- Aplicar ANTES do deploy que passa a gravar nessa coluna.

ALTER TABLE people.usuarios_provisorios
  ADD COLUMN IF NOT EXISTS dias_teste INTEGER;

COMMENT ON COLUMN people.usuarios_provisorios.dias_teste IS
  'Dias de teste remunerados decididos pelo RH no momento do acesso provisório. NULL = sem teste.';
