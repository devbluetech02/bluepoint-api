-- =====================================================
-- 045 — Permissões pros módulos que ainda não tinham filtro:
--   recrutamento, clinicas, contratos, saude, assiduidade,
--   beneficios, epi
--
-- Cada módulo ganha :ver (entrar na tela) e :gerenciar
-- (criar/editar/excluir/decidir conforme o módulo).
--
-- Defaults:
--   Nível 1 (colaborador) — nenhum (não vê nem entra)
--   Nível 2 (gestor)      — só :ver
--   Nível 3 (admin)       — :ver + :gerenciar
--
-- Idempotente. ON CONFLICT em todos os INSERTs.
-- =====================================================

INSERT INTO people.permissoes (codigo, nome, descricao, modulo, acao) VALUES
  ('recrutamento:ver',         'Ver Recrutamento',         'Ver módulo de Recrutamento (candidatos, processos, dia de teste).', 'recrutamento', 'ver'),
  ('recrutamento:gerenciar',   'Gerenciar Recrutamento',   'Iniciar processos seletivos, decidir compareceu/aprovado/reprovado, cancelar.', 'recrutamento', 'gerenciar'),
  ('clinicas:ver',             'Ver Clínicas',             'Listar clínicas cadastradas.', 'clinicas', 'ver'),
  ('clinicas:gerenciar',       'Gerenciar Clínicas',       'Cadastrar, editar e excluir clínicas.', 'clinicas', 'gerenciar'),
  ('contratos:ver',            'Ver Contratos',            'Listar templates de contratos.', 'contratos', 'ver'),
  ('contratos:gerenciar',      'Gerenciar Contratos',      'Criar, editar e excluir templates de contratos.', 'contratos', 'gerenciar'),
  ('saude:ver',                'Ver Saúde',                'Ver agenda médica e sessões de esportes.', 'saude', 'ver'),
  ('saude:gerenciar',          'Gerenciar Saúde',          'Agendar consultas e gerenciar sessões esportivas.', 'saude', 'gerenciar'),
  ('assiduidade:ver',          'Ver Assiduidade',          'Ver painel de assiduidade.', 'assiduidade', 'ver'),
  ('assiduidade:gerenciar',    'Gerenciar Assiduidade',    'Bloquear, recalcular e ajustar parâmetros de assiduidade.', 'assiduidade', 'gerenciar'),
  ('beneficios:ver',           'Ver Benefícios',           'Ver painel de benefícios.', 'beneficios', 'ver'),
  ('beneficios:gerenciar',     'Gerenciar Benefícios',     'Configurar e atribuir benefícios.', 'beneficios', 'gerenciar'),
  ('epi:ver',                  'Ver EPI',                  'Ver módulo de EPI (Equipamentos de Proteção Individual).', 'epi', 'ver'),
  ('epi:gerenciar',            'Gerenciar EPI',            'Cadastrar e atribuir EPIs.', 'epi', 'gerenciar')
ON CONFLICT (codigo) DO NOTHING;

-- Defaults por nível (gestor: só :ver; admin: tudo).
-- Buscamos os IDs das permissões recém-criadas e fazemos cross-join com
-- os níveis que devem recebê-las.
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 2, p.id, true
  FROM people.permissoes p
 WHERE p.codigo IN (
    'recrutamento:ver',
    'clinicas:ver',
    'contratos:ver',
    'saude:ver',
    'assiduidade:ver',
    'beneficios:ver',
    'epi:ver'
 )
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, true
  FROM people.permissoes p
 WHERE p.codigo IN (
    'recrutamento:ver', 'recrutamento:gerenciar',
    'clinicas:ver',     'clinicas:gerenciar',
    'contratos:ver',    'contratos:gerenciar',
    'saude:ver',        'saude:gerenciar',
    'assiduidade:ver',  'assiduidade:gerenciar',
    'beneficios:ver',   'beneficios:gerenciar',
    'epi:ver',          'epi:gerenciar'
 )
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;
