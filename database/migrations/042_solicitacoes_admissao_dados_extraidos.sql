-- Migration: 042_solicitacoes_admissao_dados_extraidos
-- Adiciona ao registro de pré-admissão as colunas usadas pelo extrator IA
-- de documentos (Camada 2 do auto-fill do contrato).
--
-- Como funciona:
--   1. Quando um documento é anexado (ou status muda para aguardando_rh),
--      um worker async marca dados_extraidos_status = 'pendente'.
--   2. O worker lê os documentos relevantes do MinIO, manda pra Claude
--      (OpenRouter) extrair PIS, CTPS, FGTS, dados bancários, etc.
--   3. Resultado é salvo em dados_extraidos como mapa de canônicos
--      (PIS, CTPS, NOME_PAI, …) — o front já tem _variableSynonyms
--      que distribui pra todos os aliases dos templates.
--   4. Modal "Enviar contrato" lê dados_extraidos e usa como fallback
--      quando _applyFormMappings não cobriu o campo.
--
-- Aditiva e idempotente: colunas nulas, sem impacto em rows existentes.

BEGIN;

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS dados_extraidos        JSONB,
  ADD COLUMN IF NOT EXISTS dados_extraidos_status TEXT,
  ADD COLUMN IF NOT EXISTS dados_extraidos_em     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dados_extraidos_erro   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'solicitacoes_admissao_dados_extraidos_status_check'
  ) THEN
    ALTER TABLE people.solicitacoes_admissao
      ADD CONSTRAINT solicitacoes_admissao_dados_extraidos_status_check
      CHECK (dados_extraidos_status IS NULL OR dados_extraidos_status IN (
        'pendente',
        'concluido',
        'falhou',
        'sem_documentos'
      ));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_solicitacoes_admissao_dados_extraidos_status
  ON people.solicitacoes_admissao(dados_extraidos_status)
  WHERE dados_extraidos_status = 'pendente';

COMMENT ON COLUMN people.solicitacoes_admissao.dados_extraidos IS
  'Mapa { CANONICAL: { valor, confianca, fonte_documento } } extraído pela IA dos documentos anexados (CTPS, RG, CNH). Canônicos batem com _variableSynonyms do front.';
COMMENT ON COLUMN people.solicitacoes_admissao.dados_extraidos_status IS
  'Estado do processamento: pendente | concluido | falhou | sem_documentos. NULL = nunca disparou.';
COMMENT ON COLUMN people.solicitacoes_admissao.dados_extraidos_em IS
  'Timestamp da última execução do worker para esta solicitação.';
COMMENT ON COLUMN people.solicitacoes_admissao.dados_extraidos_erro IS
  'Mensagem de erro quando dados_extraidos_status = falhou.';

COMMIT;
