-- Migration: 027_admissao_pipeline_v2
-- Limpeza e extensão do pipeline de admissao:
--   - remove pre_aprovado (backfill -> aso_solicitado)
--   - rename aso_enviado -> aso_recebido
--   - rename pendente -> aguardando_rh
--   - adiciona em_teste, aso_reprovado, rejeitado
--   - nova coluna status_antes_correcao (captura status antes de correcao_solicitada)
--   - nova coluna motivo_rejeicao (opcional, usado quando status = rejeitado)
--
-- Idempotente: backfills usam WHERE status='<antigo>'; rerun não afeta linhas.
-- Transacional: tudo em BEGIN/COMMIT.

BEGIN;

-- 1. Dropa CHECK antigo pra permitir os backfills
ALTER TABLE people.solicitacoes_admissao
  DROP CONSTRAINT IF EXISTS solicitacoes_admissao_status_check;

-- 2. Backfills (idempotentes)
UPDATE people.solicitacoes_admissao SET status = 'aso_solicitado' WHERE status = 'pre_aprovado';
UPDATE people.solicitacoes_admissao SET status = 'aso_recebido'   WHERE status = 'aso_enviado';
UPDATE people.solicitacoes_admissao SET status = 'aguardando_rh'  WHERE status = 'pendente';

-- Atualiza default da coluna pra refletir o novo nome (antes era 'pendente').
ALTER TABLE people.solicitacoes_admissao
  ALTER COLUMN status SET DEFAULT 'aguardando_rh';

-- 3. CHECK constraint novo
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
    'rejeitado'
  ]));

-- 4. Colunas novas
ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS status_antes_correcao TEXT,
  ADD COLUMN IF NOT EXISTS motivo_rejeicao       TEXT;

COMMENT ON COLUMN people.solicitacoes_admissao.status_antes_correcao IS
  'Status anterior à transição para correcao_solicitada. Restaurado ao reenviar após correção.';
COMMENT ON COLUMN people.solicitacoes_admissao.motivo_rejeicao IS
  'Motivo informado pelo RH ao marcar a solicitação como rejeitado. NULL em outros status.';

COMMIT;
