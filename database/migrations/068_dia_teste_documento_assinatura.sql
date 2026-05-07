-- 068_dia_teste_documento_assinatura.sql
-- Per-agendamento contract reference for dia de teste.
--
-- Antes: contrato unico em processo_seletivo.documento_assinatura_id —
-- ao "Aprovar e adicionar mais 1 dia", precisa-se de contrato NOVO
-- pra novo dia (regra de pagamento exige assinatura por dia).
-- Agora: dia_teste_agendamento.documento_assinatura_id (NULL = legado,
-- usar fallback pro processo).
--
-- Idempotente.

ALTER TABLE people.dia_teste_agendamento
  ADD COLUMN IF NOT EXISTS documento_assinatura_id TEXT;

-- Backfill: dia 1 (ordem=1) herda o doc do processo se ainda for NULL.
-- Ordem >= 2 fica NULL — eram dias adicionados sem contrato proprio
-- (legado pre-068); fluxo novo cria contrato novo na hora.
UPDATE people.dia_teste_agendamento a
   SET documento_assinatura_id = ps.documento_assinatura_id
  FROM people.processo_seletivo ps
 WHERE ps.id = a.processo_seletivo_id
   AND a.ordem = 1
   AND a.documento_assinatura_id IS NULL
   AND ps.documento_assinatura_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dia_teste_agendamento_doc_assinatura
  ON people.dia_teste_agendamento (documento_assinatura_id)
  WHERE documento_assinatura_id IS NOT NULL;

COMMENT ON COLUMN people.dia_teste_agendamento.documento_assinatura_id IS
  'ID do documento SignProof especifico deste dia de teste. Pagamento exige status=completed. Fallback pro processo_seletivo.documento_assinatura_id quando NULL (legado pre-migration 068).';
