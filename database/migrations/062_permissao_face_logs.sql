-- 062_permissao_face_logs.sql
--
-- Nova permissão granular: ver logs detalhados do reconhecimento
-- facial (people.face_recognition_logs). Permite analisar matches,
-- distâncias, decisões da LLM e cliques de "Não sou eu" sem expor
-- a tabela inteira pra qualquer admin.
--
-- Default: só nível 3 (admin) recebe. Gestor e colaborador não.
--
-- Idempotente.

INSERT INTO people.permissoes (codigo, nome, descricao, modulo, acao)
VALUES (
  'auditoria:face_logs:ver',
  'Ver Logs de Reconhecimento Facial',
  'Ver tabela detalhada de eventos do pipeline de reconhecimento facial: distâncias top-1/top-2, decisão da LLM, qualidade da imagem, cliques "Não sou eu" e marcações registradas.',
  'auditoria',
  'ver'
)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, true
  FROM people.permissoes p
 WHERE p.codigo = 'auditoria:face_logs:ver'
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;
