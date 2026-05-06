-- Migration 060_app_versoes
-- Tabela com a versao atual publicada do app mobile por plataforma.
-- Lida pelo endpoint publico /api/v1/app/versao-atual e usada pelo
-- UpdateService do mobile pra mostrar modal "Atualize o app".
--
-- Pra publicar nova versao basta UPDATE na tabela apos subir o AAB/IPA
-- na loja — sem necessidade de redeploy do backend.

BEGIN;

CREATE TABLE IF NOT EXISTS people.app_versoes (
  plataforma                  TEXT        PRIMARY KEY
                              CHECK (plataforma IN ('android','ios')),
  versao                      TEXT        NOT NULL,           -- "4.6.2"
  build                       INTEGER     NOT NULL,           -- 30
  url                         TEXT        NOT NULL,           -- Play / App Store
  -- Quando o build instalado e < deste valor, o app deve forcar a
  -- atualizacao (modal sem botao de fechar). NULL = nunca obrigatorio.
  obrigatorio_acima_de_build  INTEGER,
  atualizado_em               TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  atualizado_por              INTEGER     REFERENCES people.colaboradores(id)
);

DROP TRIGGER IF EXISTS trg_app_versoes_atualizado_em ON people.app_versoes;
CREATE TRIGGER trg_app_versoes_atualizado_em
  BEFORE UPDATE ON people.app_versoes
  FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

-- Seed inicial — bate com pubspec atual.
INSERT INTO people.app_versoes (plataforma, versao, build, url) VALUES
  ('android', '4.6.2', 30, 'https://play.google.com/store/apps/details?id=com.people.valeris'),
  ('ios',     '4.6.2', 30, 'https://apps.apple.com/br/app/people-by-valeris/id6761028795')
ON CONFLICT (plataforma) DO NOTHING;

COMMENT ON TABLE  people.app_versoes IS
  'Versao publicada do app mobile por plataforma. UPDATE quando subir nova versao na loja.';
COMMENT ON COLUMN people.app_versoes.obrigatorio_acima_de_build IS
  'Quando o build instalado e < deste valor, o app forca atualizacao (modal sem dismiss).';

COMMIT;
