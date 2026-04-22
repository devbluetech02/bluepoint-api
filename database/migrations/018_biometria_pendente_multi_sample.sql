-- Migration: 018_biometria_pendente_multi_sample
-- Adiciona suporte a multi-sample enrollment na tabela biometria_facial_pendente.
-- Agora todos os frames válidos (≥ 0.25 de qualidade) são armazenados como
-- template principal (melhor frame) + templates extras (demais frames).
-- Isso melhora a robustez do reconhecimento facial ao variar ângulo/iluminação.
--
-- Registros existentes com apenas 1 template continuam funcionando: os novos
-- campos têm default '{}' (array vazio), então nada muda no fluxo atual.

ALTER TABLE people.biometria_facial_pendente
  ADD COLUMN IF NOT EXISTS templates_extras  BYTEA[]   DEFAULT '{}'::BYTEA[],
  ADD COLUMN IF NOT EXISTS qualidades_extras NUMERIC[] DEFAULT '{}'::NUMERIC[];

COMMENT ON COLUMN people.biometria_facial_pendente.templates_extras IS
  'Encodings adicionais (ArcFace 512-d) dos demais frames com qualidade >= 0.25. '
  'Na admissão, serão copiados para biometria_facial.encodings_extras.';

COMMENT ON COLUMN people.biometria_facial_pendente.qualidades_extras IS
  'Scores de qualidade (0-1) paralelos a templates_extras, mesma ordem.';
