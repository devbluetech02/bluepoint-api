-- =====================================================
-- 076 — Permissões por página do grupo SCRUM
--
-- A migration 075 criou um único scrum:ver cobrindo as 3 páginas
-- placeholder (Rescisão, Experiências, Diaristas). Granularizamos:
-- cada página vira sua própria permissão `:ver`.
--
-- A permissão scrum:ver da 075 fica no banco (inofensiva) mas não é
-- mais usada pela sidebar — pode ser removida numa limpeza futura.
--
-- Concedidas só ao nível 3 (admin) + tipo legado 'admin' — telas em
-- construção. Quando virarem features, adicionar ao nível 2 / cargos.
--
-- Idempotente. ON CONFLICT em todos os INSERTs.
-- =====================================================

INSERT INTO people.permissoes (codigo, nome, modulo, acao, descricao) VALUES
  ('rescisao:ver',     'Ver Rescisão',     'rescisao',     'ver', 'Acessar a página de Rescisão (em construção).'),
  ('experiencias:ver', 'Ver Experiências', 'experiencias', 'ver', 'Acessar a página de Experiências (em construção).'),
  ('diaristas:ver',    'Ver Diaristas',    'diaristas',    'ver', 'Acessar a página de Diaristas (em construção).')
ON CONFLICT (codigo) DO NOTHING;

-- Nível 3 (admin)
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, TRUE
  FROM people.permissoes p
 WHERE p.codigo IN ('rescisao:ver', 'experiencias:ver', 'diaristas:ver')
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

-- Compat com o sistema legado tipo_usuario_permissoes — tipo 'admin'.
INSERT INTO people.tipo_usuario_permissoes (tipo_usuario, permissao_id, concedido)
SELECT 'admin', p.id, TRUE
  FROM people.permissoes p
 WHERE p.codigo IN ('rescisao:ver', 'experiencias:ver', 'diaristas:ver')
ON CONFLICT (tipo_usuario, permissao_id) DO NOTHING;
