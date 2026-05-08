-- =====================================================
-- BANCO: Recrutamento (DigitalOcean) — public.entrevistas_agendadas
-- =====================================================
-- Adiciona colunas pra avaliacao de aderencia IA: percentual de
-- topicos sugeridos pela IA (roteiro_entrevista) que foram realmente
-- abordados na entrevista, segundo analise LLM da transcricao.
-- =====================================================

ALTER TABLE public.entrevistas_agendadas
  ADD COLUMN IF NOT EXISTS aderencia_ia_pct numeric(5,2),
  ADD COLUMN IF NOT EXISTS aderencia_ia_avaliada_em timestamp without time zone,
  ADD COLUMN IF NOT EXISTS aderencia_ia_topicos jsonb;

COMMENT ON COLUMN public.entrevistas_agendadas.aderencia_ia_pct IS
  'Percentual 0-100 de aderencia da entrevista ao roteiro/sugestoes IA, avaliado por LLM.';
COMMENT ON COLUMN public.entrevistas_agendadas.aderencia_ia_avaliada_em IS
  'Timestamp da ultima avaliacao de aderencia.';
COMMENT ON COLUMN public.entrevistas_agendadas.aderencia_ia_topicos IS
  'JSON { abordados: string[], ausentes: string[], resumo: string } gerado pelo LLM.';
