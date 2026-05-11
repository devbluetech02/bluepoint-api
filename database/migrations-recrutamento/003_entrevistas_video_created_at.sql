-- =====================================================
-- BANCO: Recrutamento (DigitalOcean) — public.entrevistas_agendadas
-- =====================================================
-- Adiciona coluna pra armazenar o timestamp em que o vídeo da
-- entrevista foi salvo no Google Drive (createdTime via Drive API).
--
-- Diferente de:
--  - data_entrevista: INICIO AGENDADO da entrevista
--  - duracao_seg:     DURAÇÃO real do vídeo
--
-- video_created_at ≈ FIM REAL da entrevista (momento que o recording
-- terminou e foi salvo no Drive). Usado pra calcular tempo ocioso
-- entre entrevistas consecutivas do mesmo recrutador com fidelidade
-- maior que data_entrevista (que reflete só o agendamento).
--
-- Populado por cron interno (entrevistas-video-created-checker.ts).
--
-- Aplicar manualmente no banco de Recrutamento (este SQL nao roda no
-- Aurora; e do DB de Recrutamento mantido em outro projeto).
-- =====================================================

ALTER TABLE public.entrevistas_agendadas
  ADD COLUMN IF NOT EXISTS video_created_at timestamptz;

COMMENT ON COLUMN public.entrevistas_agendadas.video_created_at IS
  'Timestamp em que o video da entrevista foi salvo no Drive (createdTime). Reflete o fim real da gravacao. Populado por cron que consulta Drive API.';

-- Indice parcial pra acelerar SELECTs do checker (apenas linhas
-- com video valido e ainda nao populadas).
CREATE INDEX IF NOT EXISTS idx_entrevistas_video_created_at_pending
  ON public.entrevistas_agendadas (id DESC)
  WHERE video_id IS NOT NULL
    AND video_id <> ''
    AND video_id NOT LIKE 'SEM%'
    AND video_created_at IS NULL;

-- Indice secundario pra acelerar queries de tempo ocioso (ORDER BY
-- recrutador, video_created_at em janelas curtas).
CREATE INDEX IF NOT EXISTS idx_entrevistas_recrutador_video_created
  ON public.entrevistas_agendadas (recrutador, video_created_at)
  WHERE video_created_at IS NOT NULL;
