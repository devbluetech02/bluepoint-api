-- Migration: 031_admissao_cancelamento
-- Adiciona suporte a cancelamento de pré-admissão conforme
-- FLUXO_RECRUTAMENTO.md §5.
--
-- - Novo status 'cancelado' (terminal negativo, compartilhado entre
--   recrutamento e pré-admissão).
-- - Colunas de auditoria: quem cancelou, quando, em que etapa, com qual motivo.
--
-- Cancelamento é bloqueado apenas quando status = 'admitido' (ali o caminho
-- saudável é desligamento, não cancelamento — outro domínio).
--
-- Idempotente: DROP CONSTRAINT IF EXISTS antes de recriar; IF NOT EXISTS
-- em colunas.

BEGIN;

-- 1. Atualiza o CHECK de status pra incluir 'cancelado'
ALTER TABLE people.solicitacoes_admissao
  DROP CONSTRAINT IF EXISTS solicitacoes_admissao_status_check;

ALTER TABLE people.solicitacoes_admissao
  ADD CONSTRAINT solicitacoes_admissao_status_check
  CHECK (status = ANY (ARRAY[
    'nao_acessado',
    'aguardando_rh',
    'correcao_solicitada',
    'aso_solicitado',
    'aso_recebido',
    'em_teste',
    'aso_reprovado',
    'assinatura_solicitada',
    'contrato_assinado',
    'admitido',
    'rejeitado',
    'cancelado'
  ]));

-- 2. Colunas de auditoria do cancelamento
ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS cancelado_por        BIGINT,
  ADD COLUMN IF NOT EXISTS cancelado_em         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelado_em_etapa   TEXT,
  ADD COLUMN IF NOT EXISTS motivo_cancelamento  TEXT;

COMMENT ON COLUMN people.solicitacoes_admissao.cancelado_por IS
  'ID do usuário (DP) que cancelou a pré-admissão. NULL em outros status.';
COMMENT ON COLUMN people.solicitacoes_admissao.cancelado_em IS
  'Timestamp do cancelamento. NULL em outros status.';
COMMENT ON COLUMN people.solicitacoes_admissao.cancelado_em_etapa IS
  'Snapshot do status anterior ao cancelamento — identifica a etapa em que o processo foi interrompido.';
COMMENT ON COLUMN people.solicitacoes_admissao.motivo_cancelamento IS
  'Motivo livre opcional informado pelo DP. NULL em outros status.';

COMMIT;
