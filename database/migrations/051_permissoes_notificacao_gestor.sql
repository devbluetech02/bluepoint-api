-- =====================================================
-- 051 — Permissões de notificação pro gestor mobile (G5):
--   notificacao:atraso_equipe
--   notificacao:candidato_compareceu
--
-- Defaults:
--   Nível 1 (colaborador) — nenhum
--   Nível 2 (gestor)      — ambos
--   Nível 3 (admin)       — ambos
--
-- Idempotente.
-- =====================================================

INSERT INTO people.permissoes (codigo, nome, descricao, modulo, acao) VALUES
  ('notificacao:atraso_equipe',
   'Receber push: atraso da equipe',
   'Recebe push notification quando um colaborador da equipe registra entrada com atraso.',
   'notificacao', 'receber'),
  ('notificacao:candidato_compareceu',
   'Receber push: candidato compareceu',
   'Recebe push notification quando um candidato é marcado como presente no dia de teste.',
   'notificacao', 'receber')
ON CONFLICT (codigo) DO NOTHING;

-- Atribui aos níveis 2 (gestor) e 3 (admin).
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 2, p.id, true
  FROM people.permissoes p
 WHERE p.codigo IN (
    'notificacao:atraso_equipe',
    'notificacao:candidato_compareceu'
 )
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, true
  FROM people.permissoes p
 WHERE p.codigo IN (
    'notificacao:atraso_equipe',
    'notificacao:candidato_compareceu'
 )
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;
