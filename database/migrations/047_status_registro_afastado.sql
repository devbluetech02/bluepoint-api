-- =====================================================
-- 047 — Adiciona 'afastado' ao enum status_registro
-- =====================================================
-- O badge de status do colaborador agora cicla entre
--   ativo → afastado → inativo → ativo
-- pra cobrir o caso de afastamento médico/licença sem precisar
-- inativar o colaborador (que apaga ele de listagens default).
--
-- Idempotente via IF NOT EXISTS.
-- =====================================================

ALTER TYPE people.status_registro ADD VALUE IF NOT EXISTS 'afastado';
