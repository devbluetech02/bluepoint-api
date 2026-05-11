-- Migration: 071_permissao_relatorio_proprio
--
-- Registra a permissão granular `recrutamento:relatorio:ver_proprio`.
-- Quem tem essa permissão (e NÃO é gestor) consegue abrir a aba
-- "Relatórios" da página de Recrutamento mas vê apenas dados do
-- próprio recrutador — entrevistas, dias de teste e funil são
-- filtrados pelo nome do colaborador logado.
--
-- Gestores (nivel >= 2 ou tipo em TIPOS_GESTAO) continuam vendo todos
-- os recrutadores sem precisar dessa permissão.
--
-- SEM grants automáticos. Admin atribui caso a caso via Cargos →
-- Permissões (cargo_permissoes_override).
--
-- Idempotente.

BEGIN;

INSERT INTO people.permissoes (codigo, nome, descricao, modulo, acao)
VALUES (
  'recrutamento:relatorio:ver_proprio',
  'Ver Relatórios — escopo próprio',
  'Permite abrir a aba Relatórios em /recrutamento mas com filtros forçados ao próprio recrutador (KPIs, série diária, funil e KPIs de dias de teste todos restritos ao colaborador logado).',
  'recrutamento',
  'ver_proprio'
)
ON CONFLICT (codigo) DO NOTHING;

COMMIT;
