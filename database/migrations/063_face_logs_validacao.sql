-- 063_face_logs_validacao.sql
--
-- Adiciona colunas pra validação manual de matches em
-- people.face_recognition_logs. Admin marca um log como
-- "match correto" pela aba de Auditoria; backend usa esses
-- registros pra alimentar auto-aprendizado da biometria
-- (rosto da captura ao vivo entra como encoding aprendido
-- do colaborador escolhido — desde que respeite os limites
-- de qualidade/diversidade/cap de face-recognition.ts).
--
-- Idempotente.

ALTER TABLE people.face_recognition_logs
  ADD COLUMN IF NOT EXISTS match_validado_correto BOOLEAN,
  ADD COLUMN IF NOT EXISTS match_validado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS match_validado_por INTEGER;

CREATE INDEX IF NOT EXISTS face_recognition_logs_validado_idx
  ON people.face_recognition_logs (match_validado_correto, match_validado_em DESC)
  WHERE match_validado_correto IS NOT NULL;
