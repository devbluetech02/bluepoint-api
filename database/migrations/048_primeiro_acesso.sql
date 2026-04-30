-- =====================================================
-- 048 — Primeiro acesso: troca de senha forçada e
--       prompt de cadastro de biometria facial
-- =====================================================
-- Quando um admin/gestor cria um colaborador ou redefine
-- a senha dele, marcamos `senha_temporaria=true`. Na
-- próxima autenticação, o cliente força a troca de senha.
--
-- Após a troca (ou se o colaborador já estava com senha
-- definitiva), o cliente oferece o cadastro de biometria
-- facial. Se o usuário pular, registramos a dispensa em
-- `biometria_dispensada_em` e incrementamos
-- `biometria_dispensas_count`. Lógica do prompt:
--   count = 0                           → exibe (inicial)
--   count = 1 e dispensa >= 7 dias atrás → exibe (reaviso)
--   caso contrário                       → não exibe
--
-- Idempotente.
-- =====================================================

SET search_path TO people;

ALTER TABLE people.colaboradores
    ADD COLUMN IF NOT EXISTS senha_temporaria          BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS biometria_dispensada_em   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS biometria_dispensas_count SMALLINT    NOT NULL DEFAULT 0;

COMMENT ON COLUMN people.colaboradores.senha_temporaria          IS 'TRUE quando admin/gestor definiu a senha. Cliente força troca no próximo login e zera o flag.';
COMMENT ON COLUMN people.colaboradores.biometria_dispensada_em   IS 'Última vez que o usuário pulou o convite de cadastro de biometria facial.';
COMMENT ON COLUMN people.colaboradores.biometria_dispensas_count IS 'Quantas vezes o usuário já pulou o convite. >=2 nunca mais exibe.';
