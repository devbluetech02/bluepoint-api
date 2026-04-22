-- Migration: 006_solicitacao_admissao_usuario_provisorio
-- Vincula uma solicitação de admissão ao usuário provisório que a criou,
-- permitindo envio de push notification quando o status for alterado.

ALTER TABLE people.solicitacoes_admissao
  ADD COLUMN IF NOT EXISTS usuario_provisorio_id INTEGER
    REFERENCES people.usuarios_provisorios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_solicitacoes_admissao_usuario_provisorio
  ON people.solicitacoes_admissao (usuario_provisorio_id);

COMMENT ON COLUMN people.solicitacoes_admissao.usuario_provisorio_id
  IS 'ID do usuário provisório que enviou o formulário. Usado para enviar push via OneSignal (external_id=provisorio_<id>) quando o status mudar.';
