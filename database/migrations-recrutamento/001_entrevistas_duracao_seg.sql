-- =====================================================
-- BANCO: Recrutamento (DigitalOcean) — public.entrevistas_agendadas
-- =====================================================
-- Adiciona coluna pra armazenar duracao real do video da entrevista
-- (em segundos), preenchida via Drive API a partir de
-- videoMediaMetadata.durationMillis.
--
-- Diferente de data_entrevista (que e o INICIO agendado), esta coluna
-- e o tempo real que a entrevista durou — calculado depois do upload
-- do video pra Drive.
--
-- Aplicar manualmente no banco de Recrutamento (este SQL nao roda no
-- Aurora; e do DB de Recrutamento mantido em outro projeto).
-- =====================================================

ALTER TABLE public.entrevistas_agendadas
  ADD COLUMN IF NOT EXISTS duracao_seg integer;

COMMENT ON COLUMN public.entrevistas_agendadas.duracao_seg IS
  'Duracao real do video da entrevista em segundos. Populado por job/endpoint que le videoMediaMetadata.durationMillis no Drive.';
