-- Define jornada COMERCIAL CD (id=13) como padrão para colaboradores e usuários provisórios.
-- Garante que novos cadastros (caso jornada_id seja omitido no INSERT) caiam na jornada padrão.
ALTER TABLE people.colaboradores
  ALTER COLUMN jornada_id SET DEFAULT 13;

ALTER TABLE people.usuarios_provisorios
  ALTER COLUMN jornada_id SET DEFAULT 13;
