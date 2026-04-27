-- Migration: 037_recrutamento_processo_seletivo
-- Sprint 1 do FLUXO_RECRUTAMENTO.md (caminho B = pré-admissão direta).
--
-- Tabela mínima que liga um candidato do banco externo de Recrutamento
-- (public.candidatos no Postgres da DigitalOcean) ao usuário provisório
-- e à solicitação de admissão criados aqui no People.
--
-- Decisões importantes desta versão:
-- - O banco de Recrutamento permanece read-only — `candidato_recrutamento_id`
--   é apenas a chave da linha em public.candidatos do outro banco; nunca há
--   FK física pra ele.
-- - `candidato_cpf_norm` (apenas dígitos) é a chave de negócio que usamos
--   pra deduplicar processos por CPF.
-- - `vaga_snapshot` guarda o texto bruto da `candidatos.vaga` no momento
--   da abertura, pra auditoria caso a origem mude.
-- - `status` ainda não cobre dia_teste/referências/admissao porque caminho A
--   é Sprint 2; ampliaremos o CHECK quando entrar.
--
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS people.processo_seletivo (
  id                          BIGSERIAL PRIMARY KEY,

  -- origem (banco de Recrutamento, read-only)
  candidato_recrutamento_id   BIGINT      NOT NULL,
  candidato_cpf_norm          VARCHAR(11) NOT NULL,
  vaga_snapshot               TEXT,

  -- vínculo no People
  usuario_provisorio_id       BIGINT      REFERENCES people.usuarios_provisorios(id) ON DELETE SET NULL,
  solicitacao_admissao_id     UUID        REFERENCES people.solicitacoes_admissao(id) ON DELETE SET NULL,
  empresa_id                  BIGINT      REFERENCES people.empresas(id),
  cargo_id                    BIGINT      REFERENCES people.cargos(id),
  departamento_id             BIGINT      REFERENCES people.departamentos(id),
  jornada_id                  BIGINT      REFERENCES people.jornadas(id),

  -- status do processo
  status                      VARCHAR(40) NOT NULL DEFAULT 'aberto'
    CHECK (status IN ('aberto', 'pre_admissao', 'admitido', 'cancelado')),
  caminho                     VARCHAR(20) NOT NULL DEFAULT 'pre_admissao'
    CHECK (caminho IN ('pre_admissao', 'dia_teste')),

  -- auditoria
  criado_por                  BIGINT,
  criado_em                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- cancelamento (§5 do FLUXO)
  cancelado_por               BIGINT,
  cancelado_em                TIMESTAMPTZ,
  cancelado_em_etapa          VARCHAR(40),
  motivo_cancelamento         TEXT
);

CREATE INDEX IF NOT EXISTS idx_processo_seletivo_cpf_norm
  ON people.processo_seletivo(candidato_cpf_norm);

CREATE INDEX IF NOT EXISTS idx_processo_seletivo_status
  ON people.processo_seletivo(status);

CREATE INDEX IF NOT EXISTS idx_processo_seletivo_solicitacao
  ON people.processo_seletivo(solicitacao_admissao_id);

-- Apenas um processo "vivo" (não cancelado) por CPF.
CREATE UNIQUE INDEX IF NOT EXISTS uq_processo_seletivo_cpf_vivo
  ON people.processo_seletivo(candidato_cpf_norm)
  WHERE status <> 'cancelado';

COMMENT ON TABLE  people.processo_seletivo IS
  'Liga candidato do banco externo de Recrutamento (public.candidatos) ao usuário provisório/solicitação no People. Sprint 1 do FLUXO_RECRUTAMENTO.';
COMMENT ON COLUMN people.processo_seletivo.candidato_recrutamento_id IS
  'ID da linha em public.candidatos do banco de Recrutamento (DigitalOcean). Sem FK física — banco de origem é read-only.';
COMMENT ON COLUMN people.processo_seletivo.candidato_cpf_norm IS
  'CPF do candidato apenas em dígitos. Chave de negócio para deduplicar processos.';
COMMENT ON COLUMN people.processo_seletivo.vaga_snapshot IS
  'Texto bruto de candidatos.vaga no momento da abertura — auditoria caso a origem mude.';
COMMENT ON COLUMN people.processo_seletivo.caminho IS
  'pre_admissao = caminho B (direto ao formulário de admissão). dia_teste = caminho A (Sprint 2).';

COMMIT;
