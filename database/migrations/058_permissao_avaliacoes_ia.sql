-- 058_permissao_avaliacoes_ia.sql
--
-- Nova permissão granular: ver listagem de avaliações IA dos
-- recrutadores. Atribuída via modal de Cargo (página de Cargos →
-- aba Permissões). Endpoint GET /recrutamento/avaliacoes-ia exige.
--
-- Default: só admin (nível 3) recebe. Gestor + colaborador não.
-- Quem tem cargo "CEO" ou "Dev" precisa receber via override de cargo
-- ou nível 3.
--
-- Idempotente.

INSERT INTO people.permissoes (codigo, nome, descricao, modulo, acao)
VALUES (
  'recrutamento:avaliacoes_ia:ver',
  'Ver Avaliações IA dos Recrutadores',
  'Ver listagem de feedbacks gerados pela IA pra cada recrutador (score, veredito, pontos fortes/fracos, histórico).',
  'recrutamento',
  'ver'
)
ON CONFLICT (codigo) DO NOTHING;

-- Concede no nível 3 (admin) por padrão.
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, true
  FROM people.permissoes p
 WHERE p.codigo = 'recrutamento:avaliacoes_ia:ver'
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;
