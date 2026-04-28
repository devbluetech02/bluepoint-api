-- =====================================================
-- 041 — Cargo "Administrador" para Nível 3
-- =====================================================
-- A migration 040 colocou todos os 20 cargos no Nível 1
-- (default seguro). Antes do cutover do middleware na
-- Fase 2, atualizamos especificamente o cargo
-- "Administrador" para Nível 3 (acesso total) — caso
-- contrário, os 2 admins que NÃO são o usuário ID=1
-- (que tem god mode hardcoded) ficariam restritos.
--
-- Demais cargos continuam no Nível 1; o usuário
-- reclassifica via UI na Fase 3.
--
-- Idempotente: o WHERE filtra pelo nome e nivel_id atual.
-- =====================================================

UPDATE people.cargos
SET nivel_acesso_id = 3
WHERE nome = 'Administrador'
  AND nivel_acesso_id = 1;
