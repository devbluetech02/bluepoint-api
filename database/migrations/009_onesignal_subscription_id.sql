-- Migration: 009_onesignal_subscription_id
-- Armazena o subscription_id do OneSignal no momento do envio do formulário.
-- Permite enviar push para o dispositivo mesmo após o usuário fazer logout do OneSignal.

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS onesignal_subscription_id VARCHAR(255);

COMMENT ON COLUMN people.solicitacoes_admissao.onesignal_subscription_id IS
  'OneSignal subscription_id do dispositivo que enviou o formulário. '
  'Usado para push via include_subscription_ids, independente do login OneSignal.';
