-- =====================================================
-- 040 — Estrutura nova de hierarquia: níveis de acesso
-- =====================================================
-- Cria a infraestrutura para o novo sistema de hierarquia
-- baseado em 3 níveis (1, 2, 3), substituindo o ENUM
-- people.tipo_usuario.
--
-- COEXISTÊNCIA: esta migration NÃO altera nada que já
-- esteja em uso. As tabelas tipo_usuario_permissoes,
-- people.tipo_usuario (enum) e colaboradores.tipo
-- continuam funcionando normalmente. A nova estrutura
-- é populada e fica disponível, mas só será consumida
-- por código a partir da Fase 2 (cutover do JWT e
-- middlewares).
--
-- Idempotente (pode rodar várias vezes).
-- =====================================================

SET search_path TO people;

-- -----------------------------------------------------
-- 1. Tabela: niveis_acesso (catálogo dos 3 níveis)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS people.niveis_acesso (
    id          SERIAL PRIMARY KEY,
    nome        VARCHAR(100) NOT NULL,
    descricao   TEXT,
    criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trigger de atualização do timestamp
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_niveis_acesso_atualizado_em'
    ) THEN
        CREATE TRIGGER tr_niveis_acesso_atualizado_em
        BEFORE UPDATE ON people.niveis_acesso
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;

-- Seed dos 3 níveis (nomes neutros, descrições editáveis)
INSERT INTO people.niveis_acesso (id, nome, descricao) VALUES
  (1, 'Nível 1', 'Permissões básicas — bater ponto, ver dados próprios, criar suas solicitações'),
  (2, 'Nível 2', 'Permissões de gestão — aprovar solicitações, ver subordinados, gerar relatórios'),
  (3, 'Nível 3', 'Acesso administrativo — todas as permissões do sistema')
ON CONFLICT (id) DO NOTHING;

SELECT setval('people.niveis_acesso_id_seq', GREATEST((SELECT MAX(id) FROM people.niveis_acesso), 3), true);

-- -----------------------------------------------------
-- 2. Tabela: nivel_acesso_permissoes
-- (substitui semanticamente tipo_usuario_permissoes)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS people.nivel_acesso_permissoes (
    id              SERIAL PRIMARY KEY,
    nivel_id        INTEGER NOT NULL REFERENCES people.niveis_acesso(id) ON DELETE CASCADE,
    permissao_id    INTEGER NOT NULL REFERENCES people.permissoes(id) ON DELETE CASCADE,
    concedido       BOOLEAN DEFAULT TRUE,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por  INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    UNIQUE (nivel_id, permissao_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_nivel_acesso_permissoes_nivel     ON people.nivel_acesso_permissoes(nivel_id);
CREATE INDEX IF NOT EXISTS idx_bt_nivel_acesso_permissoes_permissao ON people.nivel_acesso_permissoes(permissao_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_nivel_acesso_permissoes_atualizado_em'
    ) THEN
        CREATE TRIGGER tr_nivel_acesso_permissoes_atualizado_em
        BEFORE UPDATE ON people.nivel_acesso_permissoes
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;

-- -----------------------------------------------------
-- 3. cargos.nivel_acesso_id (FK pra niveis_acesso)
-- -----------------------------------------------------
ALTER TABLE people.cargos
    ADD COLUMN IF NOT EXISTS nivel_acesso_id INTEGER DEFAULT 1
    REFERENCES people.niveis_acesso(id) ON DELETE SET DEFAULT;

-- Backfill: todos os cargos existentes vão pra Nível 1 (mais baixo)
-- O usuário reclassifica via UI depois (Fase 3).
UPDATE people.cargos SET nivel_acesso_id = 1 WHERE nivel_acesso_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_bt_cargos_nivel_acesso ON people.cargos(nivel_acesso_id);

-- -----------------------------------------------------
-- 4. Expansão do catálogo: aprova:* / notificacao:* / visualiza:*
-- -----------------------------------------------------
-- Permissões que cobrem as 4 dimensões: o que cada nível
-- aprova, recebe de notificação e visualiza, indo além
-- do CRUD genérico que o catálogo atual já oferece.
INSERT INTO people.permissoes (codigo, nome, modulo, acao, descricao) VALUES
  -- Aprovações granulares por tipo de solicitação
  ('aprova:solicitacao_ajuste_ponto',  'Aprovar Ajuste de Ponto',     'aprova', 'solicitacao_ajuste_ponto',  'Aprovar/rejeitar solicitações de ajuste de ponto'),
  ('aprova:solicitacao_ferias',        'Aprovar Férias',              'aprova', 'solicitacao_ferias',        'Aprovar/rejeitar solicitações de férias'),
  ('aprova:solicitacao_atestado',      'Aprovar Atestado',            'aprova', 'solicitacao_atestado',      'Aprovar/rejeitar atestados médicos'),
  ('aprova:solicitacao_ausencia',      'Aprovar Ausência',            'aprova', 'solicitacao_ausencia',      'Aprovar/rejeitar pedidos de ausência'),
  ('aprova:solicitacao_hora_extra',    'Aprovar Hora Extra (Solic.)', 'aprova', 'solicitacao_hora_extra',    'Aprovar/rejeitar solicitações de hora extra'),
  ('aprova:solicitacao_atraso',        'Aprovar Atraso',              'aprova', 'solicitacao_atraso',        'Aprovar/rejeitar justificativas de atraso'),
  ('aprova:relatorio_mensal',          'Aprovar Relatório Mensal',    'aprova', 'relatorio_mensal',          'Aprovar relatórios mensais (espelho de ponto)'),
  ('aprova:admissao',                  'Aprovar Admissão',            'aprova', 'admissao',                  'Aprovar processos de admissão'),
  ('aprova:correcao_admissao',         'Aprovar Correção Admissão',   'aprova', 'correcao_admissao',         'Aprovar correções solicitadas em admissões'),
  -- Notificações granulares
  ('notificacao:nova_solicitacao',     'Receber Nova Solicitação',    'notificacao', 'nova_solicitacao',     'Receber push/email quando nova solicitação for criada por subordinados'),
  ('notificacao:solicitacao_resposta', 'Receber Resposta de Solicitação', 'notificacao', 'solicitacao_resposta', 'Receber notificação quando suas solicitações forem aprovadas/rejeitadas'),
  ('notificacao:atraso_colaborador',   'Receber Atraso Colaborador',  'notificacao', 'atraso_colaborador',   'Receber alerta quando colaboradores atrasarem ou faltarem'),
  ('notificacao:hora_extra_pendente',  'Receber HE Pendente',         'notificacao', 'hora_extra_pendente',  'Receber notificação de horas extras pendentes de aprovação'),
  ('notificacao:nova_admissao',        'Receber Nova Admissão',       'notificacao', 'nova_admissao',        'Receber notificação quando nova admissão for iniciada'),
  ('notificacao:documento_vencendo',   'Receber Doc. Vencendo',       'notificacao', 'documento_vencendo',   'Receber alertas de documentos prestes a vencer (ASO, EPI, CNH)'),
  ('notificacao:marcacao_offline',     'Receber Marcação Offline',    'notificacao', 'marcacao_offline',     'Receber notificação de marcações sincronizadas via offline'),
  -- Visibilidade granular
  ('visualiza:colaboradores_todos',         'Ver Todos os Colaboradores',     'visualiza', 'colaboradores_todos',         'Ver dados de todos os colaboradores da empresa'),
  ('visualiza:colaboradores_subordinados',  'Ver Colaboradores Subordinados', 'visualiza', 'colaboradores_subordinados',  'Ver apenas colaboradores que reportam a você'),
  ('visualiza:colaboradores_departamento',  'Ver Colaboradores Departamento', 'visualiza', 'colaboradores_departamento',  'Ver colaboradores do mesmo departamento'),
  ('visualiza:relatorios_todos',            'Ver Relatórios de Todos',        'visualiza', 'relatorios_todos',            'Ver relatórios de toda a empresa'),
  ('visualiza:relatorios_subordinados',     'Ver Relatórios Subordinados',    'visualiza', 'relatorios_subordinados',     'Ver relatórios apenas de subordinados'),
  ('visualiza:dashboard_completo',          'Ver Dashboard Completo',         'visualiza', 'dashboard_completo',          'Ver dashboard com métricas globais'),
  ('visualiza:dashboard_resumo',            'Ver Dashboard Resumo',           'visualiza', 'dashboard_resumo',            'Ver dashboard com métricas resumidas (próprias)'),
  ('visualiza:auditoria_completa',          'Ver Auditoria Completa',         'visualiza', 'auditoria_completa',          'Ver logs de auditoria de todas as ações'),
  ('visualiza:financeiro_horas_extras',     'Ver Financeiro HE',              'visualiza', 'financeiro_horas_extras',     'Ver custo de horas extras por departamento/empresa')
ON CONFLICT (codigo) DO NOTHING;

-- =====================================================
-- 5. SEED de nivel_acesso_permissoes
-- =====================================================
-- Mapeamento por nível:
--   Nível 3 = todas as 69 permissões originais + todas as novas (god mode)
--   Nível 2 = igual ao gestor atual + aprovações granulares + notificações de gestão + visualizações
--   Nível 1 = perfil colaborador básico (bater ponto, criar solicitações, ver próprios dados)
-- =====================================================

-- Nível 3 = TUDO (todas permissões existentes + novas)
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 3, p.id, TRUE FROM people.permissoes p
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

-- Nível 2 = espelho do gestor atual + extras de gestão
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 2, p.id, TRUE
FROM people.permissoes p
WHERE p.codigo IN (
    -- Permissões herdadas do gestor atual
    'acompanhamento:ver',
    'acompanhamento:ver_todos',
    'dashboard:ver',
    'feriados:listar',
    'horas_extras:aprovar',
    'horas_extras:listar',
    'marcacoes:listar',
    'marcacoes:listar_todos',
    'relatorios:espelho_ponto',
    'relatorios:gerar',
    'solicitacoes:aprovar',
    'solicitacoes:listar',
    'solicitacoes:listar_todos',
    -- Aprovações granulares (gestores aprovam tudo de subordinados)
    'aprova:solicitacao_ajuste_ponto',
    'aprova:solicitacao_ferias',
    'aprova:solicitacao_atestado',
    'aprova:solicitacao_ausencia',
    'aprova:solicitacao_hora_extra',
    'aprova:solicitacao_atraso',
    'aprova:relatorio_mensal',
    -- Notificações de gestão
    'notificacao:nova_solicitacao',
    'notificacao:atraso_colaborador',
    'notificacao:hora_extra_pendente',
    'notificacao:documento_vencendo',
    'notificacao:marcacao_offline',
    -- Visibilidade
    'visualiza:colaboradores_subordinados',
    'visualiza:relatorios_subordinados',
    'visualiza:dashboard_completo',
    -- Lista colaboradores subordinados
    'colaboradores:listar',
    'colaboradores:obter'
)
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

-- Nível 1 = perfil colaborador básico
INSERT INTO people.nivel_acesso_permissoes (nivel_id, permissao_id, concedido)
SELECT 1, p.id, TRUE
FROM people.permissoes p
WHERE p.codigo IN (
    'dashboard:ver',
    'marcacoes:registrar',          -- bater ponto próprio
    'marcacoes:listar',             -- ver próprias marcações
    'banco_horas:listar',           -- ver próprio banco de horas
    'solicitacoes:listar',          -- ver próprias solicitações
    'solicitacoes:criar',           -- criar suas solicitações
    'horas_extras:listar',          -- ver próprias HE
    'feriados:listar',              -- calendário de feriados
    'notificacoes:listar',          -- ver notificações
    'notificacao:solicitacao_resposta', -- receber retorno de aprovação/rejeição
    'visualiza:dashboard_resumo'    -- dashboard resumido próprio
)
ON CONFLICT (nivel_id, permissao_id) DO NOTHING;

-- =====================================================
-- FIM da migration 040.
--
-- Estado pós-migration:
--   - 3 níveis em niveis_acesso
--   - cargos.nivel_acesso_id preenchido (todos cargos = 1)
--   - permissoes expandido com aprova:* / notificacao:* / visualiza:*
--   - nivel_acesso_permissoes populado com mapeamento inicial
--   - Nada do que estava em uso foi alterado
--
-- Próximas fases:
--   Fase 2 — JWT + middlewares passam a consultar nivel_acesso_permissoes
--   Fase 3 — UI web pra gerenciar níveis e atribuir nível ao cargo
--   Fase 4 — limpeza (drop tipo_usuario_permissoes, drop ENUM, etc.)
-- =====================================================
