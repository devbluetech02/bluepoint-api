-- 051_recrutador_avaliacao_ia.sql
--
-- Tabela pra guardar as avaliações de performance do recrutador
-- geradas pela IA (OpenRouter) com base nas análises de entrevista
-- agregadas. Cada linha = um ciclo de avaliação concluído.
--
-- Fluxo:
--   1. Cron periódico (ou trigger por contagem) chama
--      POST /api/v1/recrutamento/avaliar-recrutador?nome=X
--   2. Endpoint pega últimas N entrevistas com análise IA daquele
--      recrutador e manda pro modelo gerar score+feedback.
--   3. Resultado é gravado aqui. Se score for "ruim" 2x seguidas,
--      gera notificação pro gestor (campo notificou_gestor_em).
--   4. Recrutador, ao logar, puxa feedback_pendente (linha mais
--      recente com visto_em IS NULL) e mostra como popup.

CREATE TABLE IF NOT EXISTS people.recrutador_avaliacao_ia (
  id BIGSERIAL PRIMARY KEY,
  recrutador_nome TEXT NOT NULL,                  -- normalizado UPPER+TRIM
  periodo_de DATE NOT NULL,
  periodo_ate DATE NOT NULL,
  entrevistas_avaliadas INT NOT NULL,             -- quantas análises foram passadas pro modelo
  score INT NOT NULL,                              -- 0-100
  veredito TEXT NOT NULL                           -- 'bom' | 'regular' | 'ruim'
    CHECK (veredito IN ('bom', 'regular', 'ruim')),
  feedback_recrutador TEXT NOT NULL,               -- mensagem do popup (tom motivacional)
  feedback_gestor TEXT,                            -- resumo executivo se for ruim
  pontos_fortes JSONB,                             -- array de strings
  pontos_fracos JSONB,                             -- array de strings
  modelo_ia TEXT,                                  -- ex: anthropic/claude-sonnet-4.5
  visto_em TIMESTAMPTZ,                            -- recrutador clicou "ok" no popup
  notificou_gestor_em TIMESTAMPTZ,                 -- push pro gestor disparado
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recrutador_avaliacao_ia_nome
  ON people.recrutador_avaliacao_ia (recrutador_nome, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_recrutador_avaliacao_ia_pendente
  ON people.recrutador_avaliacao_ia (recrutador_nome, criado_em DESC)
  WHERE visto_em IS NULL;
