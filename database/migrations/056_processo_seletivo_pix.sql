-- Migration: 056_processo_seletivo_pix
-- Snapshot da chave PIX informada pelo recrutador no modal "Iniciar processo
-- People". Antes os dados PIX ficavam apenas no contrato SignProof e no
-- banco externo de Recrutamento (read-only). Pra pagar o candidato após
-- aprovar/reprovar, o backend precisa ter os dados aqui — caso contrário
-- exige override do gestor no app.
--
-- Aditiva e idempotente.

BEGIN;

ALTER TABLE people.processo_seletivo
  ADD COLUMN IF NOT EXISTS pix_chave      TEXT,
  ADD COLUMN IF NOT EXISTS pix_tipo_chave TEXT,
  ADD COLUMN IF NOT EXISTS pix_banco      TEXT;

COMMENT ON COLUMN people.processo_seletivo.pix_chave IS
  'Chave PIX informada pelo recrutador no modal Iniciar Processo. Tem precedencia sobre o que estiver no banco de Recrutamento — recrutador pode corrigir no momento da abertura.';
COMMENT ON COLUMN people.processo_seletivo.pix_tipo_chave IS
  'Tipo da chave PIX (cpf|cnpj|email|telefone|aleatoria).';
COMMENT ON COLUMN people.processo_seletivo.pix_banco IS
  'Banco da chave PIX (texto livre, opcional).';

COMMIT;
