-- =====================================================
-- 075 — Permissão scrum:ver
--
-- O grupo "SCRUM" da sidebar ganhou páginas placeholder
-- (Rescisão, Experiências, Diaristas) que ainda não têm gate.
-- Sem permissão exigida, recrutadores (e qualquer cargo de
-- nível 1) acabavam caindo na tela "Rescisão" como página
-- inicial, porque era o primeiro item visível da sidebar.
--
-- Cria scrum:ver e concede APENAS ao nível 3 (admin) por
-- enquanto — são telas em construção. Quando virarem features
-- reais, adicionar ao nível 2 / cargos específicos.
--
-- Idempotente. ON CONFLICT em todos os INSERTs.
-- =====================================================

INSERT INTO people.permissoes (codigo, nome, modulo, acao, descricao) VALUES
  ('scrum:ver', 'Ver módulo SCRUM', 'scrum', 'ver',
   'Acessar páginas em construção do módulo SCRUM (Rescisão, Experiências, Diaristas).')
ON CONFLICT (codigo) DO NOTHING;

-- Nível 3 (admin) — recebe a permissão nova.
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, TRUE
  FROM people.permissoes p
 WHERE p.codigo = 'scrum:ver'
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

-- Compat com o sistema legado tipo_usuario_permissoes — tipo 'admin'.
INSERT INTO people.tipo_usuario_permissoes (tipo_usuario, permissao_id, concedido)
SELECT 'admin', p.id, TRUE
  FROM people.permissoes p
 WHERE p.codigo = 'scrum:ver'
ON CONFLICT (tipo_usuario, permissao_id) DO NOTHING;
