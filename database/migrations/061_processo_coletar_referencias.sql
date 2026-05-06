-- =====================================================
-- MIGRAÇÃO 061: Estado intermediário "coletar_referencias"
--
-- Antes: dia_teste -> pre_admissao (direto após gestor aprovar+encerrar).
-- Agora: dia_teste -> coletar_referencias -> pre_admissao.
--
-- O candidato aprovado fica na fase "coletar_referencias" até o RH
-- confirmar 2 referências (gravadas em public.candidatos no banco
-- Recrutamento). Só então cria provisório+solicitação e move pra
-- pre_admissao.
-- =====================================================

ALTER TABLE people.processo_seletivo
  DROP CONSTRAINT IF EXISTS processo_seletivo_status_check;

ALTER TABLE people.processo_seletivo
  ADD CONSTRAINT processo_seletivo_status_check
    CHECK (status IN (
      'aberto',
      'dia_teste',
      'coletar_referencias',
      'pre_admissao',
      'admitido',
      'cancelado'
    ));
