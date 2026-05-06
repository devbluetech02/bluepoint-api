-- Migration 064_recrutamento_split_gerenciar
--
-- Quebra a permissão `recrutamento:gerenciar` em duas mais granulares:
--   - `recrutamento:iniciar_processo` — abrir processo seletivo
--     (caminho A "Dia de Teste" ou caminho B "Pré-admissão direta").
--   - `recrutamento:decidir`          — agir sobre dia de teste já
--     em curso: compareceu / aprovado / reprovado / cancelar.
--
-- Backfill: todo nível ou cargo que tinha `recrutamento:gerenciar`
-- recebe as duas novas permissões mantendo o mesmo flag `concedido`.
-- A permissão antiga é removida ao final.

BEGIN;

-- 1) Cria as duas novas permissões (idempotente)
INSERT INTO people.permissoes (codigo, nome, descricao, modulo, acao) VALUES
  ('recrutamento:iniciar_processo',
   'Iniciar Processo Seletivo',
   'Abrir um processo seletivo a partir de um candidato (caminho Dia de Teste ou Pré-admissão direta).',
   'recrutamento',
   'iniciar_processo'),
  ('recrutamento:decidir',
   'Decidir/Cancelar Processo Seletivo',
   'Agir sobre um processo em curso: marcar comparecimento, aprovar, reprovar, registrar desistência ou cancelar.',
   'recrutamento',
   'decidir')
ON CONFLICT (codigo) DO NOTHING;

-- 2) Backfill — para cada nível com `recrutamento:gerenciar`, copia
--    o flag `concedido` para as duas novas permissões.
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT nap.nivel_id, p_new.id, nap.concedido
  FROM people.nivel_acesso_permissoes nap
  JOIN people.permissoes p_old ON p_old.id = nap.permissao_id
 CROSS JOIN people.permissoes p_new
 WHERE p_old.codigo = 'recrutamento:gerenciar'
   AND p_new.codigo IN ('recrutamento:iniciar_processo', 'recrutamento:decidir')
ON CONFLICT DO NOTHING;

-- 3) Idem para overrides de cargo.
INSERT INTO people.cargo_permissoes_override (cargo_id, permissao_id, concedido)
SELECT cpo.cargo_id, p_new.id, cpo.concedido
  FROM people.cargo_permissoes_override cpo
  JOIN people.permissoes p_old ON p_old.id = cpo.permissao_id
 CROSS JOIN people.permissoes p_new
 WHERE p_old.codigo = 'recrutamento:gerenciar'
   AND p_new.codigo IN ('recrutamento:iniciar_processo', 'recrutamento:decidir')
ON CONFLICT DO NOTHING;

-- 4) Remove a permissão antiga e seus vínculos.
DELETE FROM people.cargo_permissoes_override
 WHERE permissao_id IN (
   SELECT id FROM people.permissoes WHERE codigo = 'recrutamento:gerenciar'
 );

DELETE FROM people.nivel_acesso_permissoes
 WHERE permissao_id IN (
   SELECT id FROM people.permissoes WHERE codigo = 'recrutamento:gerenciar'
 );

DELETE FROM people.permissoes WHERE codigo = 'recrutamento:gerenciar';

COMMIT;
