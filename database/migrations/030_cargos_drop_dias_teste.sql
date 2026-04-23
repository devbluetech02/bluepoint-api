-- Migration: 030_cargos_drop_dias_teste
-- Remove dias_teste de cargos. O conceito foi movido para usuarios_provisorios
-- (ver migração 029).
-- Sem backfill: valores antigos são descartados (task trata como mudança de modelo).
-- Aplicar DEPOIS do deploy que parou de referenciar cargos.dias_teste, evitando
-- que o código em execução quebre em listar/obter/criar/atualizar cargo.

ALTER TABLE people.cargos DROP COLUMN IF EXISTS dias_teste;
