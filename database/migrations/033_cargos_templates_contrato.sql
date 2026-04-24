-- Migration: 033_cargos_templates_contrato
-- Associa cada cargo a uma lista de templates SignProof que o DP deve enviar
-- no contrato de pré-admissão. Array vazio = DP escolhe caso a caso
-- (comportamento atual para cargos não configurados).
--
-- IDs armazenados são os mesmos retornados por GET /api/v1/signproof/templates
-- (globais como 'admissao_v1' ou UUIDs de templates custom).
--
-- Idempotente: IF NOT EXISTS.

BEGIN;

ALTER TABLE people.cargos
  ADD COLUMN IF NOT EXISTS templates_contrato_admissao TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN people.cargos.templates_contrato_admissao IS
  'Lista de IDs de templates SignProof usados no envio de contrato de pré-admissão deste cargo. Array vazio = DP escolhe caso a caso.';

COMMIT;
