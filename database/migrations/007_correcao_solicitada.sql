-- Migration: 007_correcao_solicitada
-- Adiciona status 'correcao_solicitada' e coluna para armazenar quais
-- campos/documentos precisam ser corrigidos.

-- 1. Remover constraint antiga e recriar com novo status
ALTER TABLE people.solicitacoes_admissao
  DROP CONSTRAINT solicitacoes_admissao_status_check;

ALTER TABLE people.solicitacoes_admissao
  ADD CONSTRAINT solicitacoes_admissao_status_check
    CHECK (status = ANY (ARRAY[
      'pendente',
      'correcao_solicitada',
      'pre_aprovado',
      'aso_solicitado',
      'aso_enviado',
      'admitido'
    ]));

-- 2. Coluna para detalhes da correção solicitada
ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS pendencias_correcao JSONB;

COMMENT ON COLUMN people.solicitacoes_admissao.pendencias_correcao IS
  'Detalhes da correção solicitada: { campos: string[], documentos: number[], observacao: string }';
