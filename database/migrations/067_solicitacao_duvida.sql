-- 067_solicitacao_duvida.sql
-- Tipo de solicitação "dúvida" + status "respondida" + coluna resposta.
-- Gestor responde solicitações de dúvida em vez de aprovar/rejeitar.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'tipo_solicitacao' AND e.enumlabel = 'duvida'
  ) THEN
    ALTER TYPE people.tipo_solicitacao ADD VALUE 'duvida';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'status_solicitacao' AND e.enumlabel = 'respondida'
  ) THEN
    ALTER TYPE people.status_solicitacao ADD VALUE 'respondida';
  END IF;
END $$;

ALTER TABLE people.solicitacoes
  ADD COLUMN IF NOT EXISTS resposta TEXT,
  ADD COLUMN IF NOT EXISTS respondido_por INTEGER REFERENCES people.colaboradores(id),
  ADD COLUMN IF NOT EXISTS respondido_em TIMESTAMP;
