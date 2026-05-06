-- =====================================================
-- Migration 061: Tabela de logs do reconhecimento facial
-- =====================================================
-- Captura todo evento relevante do pipeline de reconhecimento
-- (verificar-face, tiebreak-face, tiebreak-confirmar + cliques
-- "não sou eu" do cliente) para análise posterior:
--
--   - Distâncias top-1 / top-2 + gap → ajustar threshold
--   - Qualidade da imagem nos casos de falha → entender ambiente
--   - Quem é proposto vs quem é confirmado → mapear false positives
--   - Decisão do LLM em borderline → tunar prompt
--   - Cliques "não sou eu" → casos onde ArcFace acerta mas user rejeita
--   - Latência por estágio → encontrar gargalo
--
-- Idempotente.
-- =====================================================

CREATE TABLE IF NOT EXISTS people.face_recognition_logs (
  id                          BIGSERIAL PRIMARY KEY,
  evento                      VARCHAR(40)  NOT NULL,
  data_hora                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Contexto da requisição
  origem                      VARCHAR(30),    -- 'totem' | 'app' | 'web' | etc
  endpoint                    VARCHAR(40),    -- 'verificar-face' | 'tiebreak-face' | ...
  ip                          VARCHAR(45),
  user_agent                  TEXT,
  dispositivo_codigo          VARCHAR(20),
  latitude                    NUMERIC(10, 7),
  longitude                   NUMERIC(10, 7),

  -- Match no ArcFace
  colaborador_id_proposto     INTEGER,
  colaborador_id_confirmado   INTEGER,
  external_id_proposto        JSONB,
  distancia_top1              NUMERIC(8, 6),
  distancia_top2              NUMERIC(8, 6),
  gap_top12                   NUMERIC(8, 6),
  threshold_efetivo           NUMERIC(6, 4),

  -- Qualidade da imagem
  qualidade                   NUMERIC(6, 4),
  qualidade_detalhada         JSONB,          -- { detScore, sizeScore, centerScore }

  -- LLM (verify/tiebreak)
  llm_modelo                  VARCHAR(80),
  llm_confirmou               BOOLEAN,
  llm_confidence              NUMERIC(5, 3),
  llm_razao                   TEXT,
  llm_latency_ms              INTEGER,

  -- Captura
  foto_url                    TEXT,           -- url do storage pra revisão visual

  -- Resultado / latência
  duracao_ms                  INTEGER,        -- tempo total do request
  marcacao_id                 INTEGER,        -- quando virou ponto registrado

  -- Outras infos contextuais (top-N candidatos, motivo erro, etc)
  metadados                   JSONB,

  criado_em                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Constraint dos eventos suportados (relaxa em VARCHAR pra permitir
-- adicionar tipos novos sem migration; check de domínio em código).
COMMENT ON COLUMN people.face_recognition_logs.evento IS
  'Tipos: FACE_NOT_DETECTED, LOW_QUALITY, NO_FACES_REGISTERED, NOT_IDENTIFIED, ' ||
  'AMBIGUOUS_MATCH, LLM_REJECTED, INACTIVE_COLLABORATOR, MATCH_PROPOSED, ' ||
  'MATCH_CONFIRMED, MATCH_REJECTED_BY_USER, TIEBREAK_PROPOSED, ' ||
  'TIEBREAK_NO_MATCH, TIEBREAK_CONFIRMED, TIEBREAK_REJECTED_BY_USER, ' ||
  'INTERNAL_ERROR';

-- Índices para análises mais comuns
CREATE INDEX IF NOT EXISTS face_recognition_logs_data_hora_idx
  ON people.face_recognition_logs (data_hora DESC);

CREATE INDEX IF NOT EXISTS face_recognition_logs_evento_idx
  ON people.face_recognition_logs (evento, data_hora DESC);

CREATE INDEX IF NOT EXISTS face_recognition_logs_colab_proposto_idx
  ON people.face_recognition_logs (colaborador_id_proposto, data_hora DESC)
  WHERE colaborador_id_proposto IS NOT NULL;

CREATE INDEX IF NOT EXISTS face_recognition_logs_colab_confirmado_idx
  ON people.face_recognition_logs (colaborador_id_confirmado, data_hora DESC)
  WHERE colaborador_id_confirmado IS NOT NULL;

CREATE INDEX IF NOT EXISTS face_recognition_logs_dispositivo_idx
  ON people.face_recognition_logs (dispositivo_codigo, data_hora DESC)
  WHERE dispositivo_codigo IS NOT NULL;
