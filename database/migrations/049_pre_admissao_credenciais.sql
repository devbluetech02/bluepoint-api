-- Migration: 049_pre_admissao_credenciais
-- Materializa email + senha_hash do candidato em colunas próprias da
-- solicitação de admissão, para que o login email+senha possa identificar
-- pré-admissões em andamento e redirecionar o candidato para o ponto certo
-- do fluxo (ex.: tela ASO).
--
-- Hoje email e senha vivem dentro de `dados` JSONB (senha em PLAIN TEXT, key
-- por UUID do campo do formulário). Isto:
--   1. impede query eficiente por email no /autenticar fallback;
--   2. expõe senha em texto puro no banco.
--
-- Esta migration:
--   - adiciona pre_admissao_email + pre_admissao_senha_hash;
--   - cria índice parcial único por email enquanto o candidato está ativo
--     (qualquer status que não seja terminal-falha nem 'admitido');
--   - NÃO faz backfill aqui (as senhas plain do JSONB serão hasheadas pelo
--     próprio endpoint /admissao/enviar a cada submit + por script de
--     backfill rodado uma única vez fora desta migration).
--
-- Aditiva e idempotente.

BEGIN;

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS pre_admissao_email      TEXT,
  ADD COLUMN IF NOT EXISTS pre_admissao_senha_hash TEXT;

-- Índice único parcial: garante 1 candidato ATIVO por email. Status
-- 'admitido' / 'rejeitado' / 'aso_reprovado' são terminais — nesses casos o
-- candidato vira (ou não vira) colaborador e o login normal toma conta. Fora
-- desses, o email só pode estar ativo em UMA solicitação.
CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitacoes_admissao_pre_email_ativo
  ON people.solicitacoes_admissao (LOWER(pre_admissao_email))
  WHERE pre_admissao_email IS NOT NULL
    AND status NOT IN ('admitido', 'rejeitado', 'aso_reprovado');

COMMENT ON COLUMN people.solicitacoes_admissao.pre_admissao_email IS
  'Email informado pelo candidato no formulário de pré-admissão. Materializado a partir de dados JSONB pelo endpoint /admissao/enviar para permitir lookup eficiente no fallback do /autenticar.';
COMMENT ON COLUMN people.solicitacoes_admissao.pre_admissao_senha_hash IS
  'Bcrypt hash da senha que o candidato cadastrou no formulário ("Crie uma senha"). Substitui o plain-text que estava em dados JSONB. Comparado em /autenticar antes de redirecionar para tela ASO/pré-admissão.';

COMMIT;
