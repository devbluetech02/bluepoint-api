-- Migration: 038_recrutamento_dia_teste
-- Sprint 2.1 do FLUXO_RECRUTAMENTO.md (caminho A — dia de teste).
--
-- O que entra:
--  - parametros_rh: 4 defaults globais de dia de teste editáveis pelo
--    admin em "Parâmetros de Recrutamento" (frontend).
--  - cargos: 1 coluna de template SignProof default pro caminho A.
--    Sem fallback rígido: o handler decide por nome do cargo se a coluna
--    estiver vazia (vendedor → termo_ciencia, demais → contrato_autonomo).
--  - dia_teste_agendamento: 1 linha por dia agendado. Limite de 2 dias
--    por processo (ordem 1 ou 2) — mesmo limite dos templates SignProof
--    (DATA_SERVICO_1/2 e DATA_TREINAMENTO_1/2).
--  - processo_seletivo.status passa a aceitar 'dia_teste'.
--  - processo_seletivo.documento_assinatura_id pra rastrear o doc do
--    SignProof gerado pro caminho A.
--
-- Idempotente.

BEGIN;

-- ── parametros_rh: defaults globais de dia de teste ────────────────────────
ALTER TABLE people.parametros_rh
  ADD COLUMN IF NOT EXISTS dias_teste_padrao            INTEGER       NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS carga_horaria_teste_padrao   INTEGER       NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS valor_diaria_teste_padrao    NUMERIC(10,2) NOT NULL DEFAULT 10.00,
  ADD COLUMN IF NOT EXISTS percentual_minimo_decisao    INTEGER       NOT NULL DEFAULT 50;

ALTER TABLE people.parametros_rh
  ADD CONSTRAINT chk_parametros_rh_dias_teste_padrao
    CHECK (dias_teste_padrao BETWEEN 1 AND 2);
ALTER TABLE people.parametros_rh
  ADD CONSTRAINT chk_parametros_rh_carga_horaria_teste
    CHECK (carga_horaria_teste_padrao BETWEEN 1 AND 12);
ALTER TABLE people.parametros_rh
  ADD CONSTRAINT chk_parametros_rh_percentual_minimo
    CHECK (percentual_minimo_decisao BETWEEN 0 AND 100);

COMMENT ON COLUMN people.parametros_rh.dias_teste_padrao IS
  'Dias de teste padrão sugeridos no modal de Iniciar Processo (1 ou 2). Editável por processo.';
COMMENT ON COLUMN people.parametros_rh.carga_horaria_teste_padrao IS
  'Carga horária default por dia de teste (em horas). Editável por processo.';
COMMENT ON COLUMN people.parametros_rh.valor_diaria_teste_padrao IS
  'Valor padrão (R$) da diária do dia de teste. Editável por processo no modal.';
COMMENT ON COLUMN people.parametros_rh.percentual_minimo_decisao IS
  'Percentual mínimo da carga horária do dia que precisa ser cumprido pra o gestor poder decidir aprovar/reprovar (default 50).';

-- ── cargos: template SignProof default pro dia de teste ────────────────────
ALTER TABLE people.cargos
  ADD COLUMN IF NOT EXISTS template_dia_teste TEXT;

COMMENT ON COLUMN people.cargos.template_dia_teste IS
  'ID do template SignProof default usado no contrato de dia de teste deste cargo. NULL = handler decide por heurística do nome (vendedor → termo_ciencia, demais → contrato_autonomo).';

-- ── processo_seletivo: amplia status + adiciona referência ao contrato ────
ALTER TABLE people.processo_seletivo
  DROP CONSTRAINT IF EXISTS processo_seletivo_status_check;
ALTER TABLE people.processo_seletivo
  ADD CONSTRAINT processo_seletivo_status_check
    CHECK (status IN ('aberto', 'dia_teste', 'pre_admissao', 'admitido', 'cancelado'));

ALTER TABLE people.processo_seletivo
  ADD COLUMN IF NOT EXISTS documento_assinatura_id TEXT;
COMMENT ON COLUMN people.processo_seletivo.documento_assinatura_id IS
  'ID do documento criado no SignProof pro caminho A. NULL pra caminho B.';

-- ── dia_teste_agendamento: 1 linha por dia agendado ────────────────────────
CREATE TABLE IF NOT EXISTS people.dia_teste_agendamento (
  id                    BIGSERIAL PRIMARY KEY,
  processo_seletivo_id  BIGINT      NOT NULL REFERENCES people.processo_seletivo(id) ON DELETE CASCADE,
  ordem                 INTEGER     NOT NULL CHECK (ordem BETWEEN 1 AND 2),
  data                  DATE        NOT NULL,
  valor_diaria          NUMERIC(10,2) NOT NULL,
  carga_horaria         INTEGER     NOT NULL CHECK (carga_horaria BETWEEN 1 AND 12),
  gestor_id             BIGINT,
  status                VARCHAR(30) NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado','compareceu','nao_compareceu','aprovado','reprovado','desistencia','cancelado')),
  decidido_por          BIGINT,
  decidido_em           TIMESTAMPTZ,
  percentual_concluido  INTEGER     CHECK (percentual_concluido BETWEEN 0 AND 100),
  valor_a_pagar         NUMERIC(10,2),
  pagamento_pix_id      BIGINT,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dia_teste_processo_ordem
  ON people.dia_teste_agendamento(processo_seletivo_id, ordem);
CREATE INDEX IF NOT EXISTS idx_dia_teste_data
  ON people.dia_teste_agendamento(data);
CREATE INDEX IF NOT EXISTS idx_dia_teste_status
  ON people.dia_teste_agendamento(status);
CREATE INDEX IF NOT EXISTS idx_dia_teste_gestor
  ON people.dia_teste_agendamento(gestor_id) WHERE gestor_id IS NOT NULL;

COMMENT ON TABLE  people.dia_teste_agendamento IS
  'Cada linha = 1 dia de teste agendado pra um processo_seletivo (caminho A). Ordem 1 ou 2 (limite dos templates SignProof). Calculo de valor_a_pagar via regras §3.6 do FLUXO.';
COMMENT ON COLUMN people.dia_teste_agendamento.pagamento_pix_id IS
  'FK pra people.pagamento_pix quando essa tabela vier (Sprint 2.3). Por agora só guarda o ID sem constraint.';

COMMIT;
