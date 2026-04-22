-- Migration: 008_status_assinatura
-- Adiciona status 'assinatura_solicitada' e 'contrato_assinado'

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
      'assinatura_solicitada',
      'contrato_assinado',
      'admitido'
    ]));
