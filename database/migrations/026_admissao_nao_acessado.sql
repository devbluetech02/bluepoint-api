-- Migration: 026_admissao_nao_acessado
-- Introduz o status 'nao_acessado' em solicitacoes_admissao, representando
-- "acesso criado pelo RH, candidato ainda não abriu o app".
--
-- Mudanças:
--   1. Adiciona 'nao_acessado' à CHECK constraint de status.
--   2. Troca FK usuario_provisorio_id: ON DELETE SET NULL → ON DELETE CASCADE,
--      pois agora cada provisório tem solicitação vinculada 1:1.
--   3. Backfill: insere uma solicitação 'nao_acessado' pra cada provisório
--      que ainda não tem solicitação vinculada. Idempotente.

-- 1. Atualiza CHECK de status (idempotente via DROP IF EXISTS + ADD)
ALTER TABLE people.solicitacoes_admissao
  DROP CONSTRAINT IF EXISTS solicitacoes_admissao_status_check;

ALTER TABLE people.solicitacoes_admissao
  ADD CONSTRAINT solicitacoes_admissao_status_check
  CHECK (status = ANY (ARRAY[
    'nao_acessado',
    'pendente',
    'correcao_solicitada',
    'pre_aprovado',
    'aso_solicitado',
    'aso_enviado',
    'assinatura_solicitada',
    'contrato_assinado',
    'admitido'
  ]));

-- 2. Troca FK para CASCADE
ALTER TABLE people.solicitacoes_admissao
  DROP CONSTRAINT IF EXISTS solicitacoes_admissao_usuario_provisorio_id_fkey;

ALTER TABLE people.solicitacoes_admissao
  ADD CONSTRAINT solicitacoes_admissao_usuario_provisorio_id_fkey
  FOREIGN KEY (usuario_provisorio_id)
  REFERENCES people.usuarios_provisorios(id)
  ON DELETE CASCADE;

-- 3. Backfill: stubs 'nao_acessado' para provisórios órfãos.
--    Idempotente via NOT EXISTS. Se não houver formulário ativo, apenas loga e sai.
DO $$
DECLARE
  v_formulario UUID;
  v_inseridos  INTEGER;
BEGIN
  SELECT id INTO v_formulario
  FROM people.formularios_admissao
  WHERE ativo = true
  ORDER BY atualizado_em DESC
  LIMIT 1;

  IF v_formulario IS NULL THEN
    RAISE NOTICE 'Nenhum formulário de admissão ativo — backfill pulado';
    RETURN;
  END IF;

  INSERT INTO people.solicitacoes_admissao (formulario_id, status, dados, usuario_provisorio_id)
  SELECT v_formulario, 'nao_acessado', '{}'::jsonb, up.id
  FROM people.usuarios_provisorios up
  WHERE NOT EXISTS (
    SELECT 1 FROM people.solicitacoes_admissao s
    WHERE s.usuario_provisorio_id = up.id
  );

  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  RAISE NOTICE 'Backfill nao_acessado: % linha(s) inserida(s)', v_inseridos;
END;
$$;
