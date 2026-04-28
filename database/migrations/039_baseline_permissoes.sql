-- =====================================================
-- 039 — Baseline de permissões e tipo_usuario_permissoes
-- =====================================================
-- Objetivo: versionar no repositório o estado atual das
-- tabelas `permissoes` e `tipo_usuario_permissoes` que
-- foram criadas direto no banco AWS sem migration.
--
-- Idempotente: pode rodar em ambiente que já tenha as
-- tabelas e o seed (CREATE TABLE IF NOT EXISTS / INSERT
-- ON CONFLICT DO NOTHING). Não modifica registros que
-- já existam.
--
-- Snapshot capturado em 2026-04-28 do banco de produção.
-- =====================================================

SET search_path TO people;

-- -----------------------------------------------------
-- Tabela: permissoes
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS people.permissoes (
    id          SERIAL PRIMARY KEY,
    codigo      VARCHAR(100) NOT NULL UNIQUE,
    nome        VARCHAR(150) NOT NULL,
    descricao   TEXT,
    modulo      VARCHAR(50)  NOT NULL,
    acao        VARCHAR(50)  NOT NULL,
    criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bt_permissoes_codigo ON people.permissoes(codigo);
CREATE INDEX IF NOT EXISTS idx_bt_permissoes_modulo ON people.permissoes(modulo);

-- -----------------------------------------------------
-- Tabela: tipo_usuario_permissoes
-- (vincula um tipo_usuario do enum people.tipo_usuario
--  às permissões que ele recebe)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS people.tipo_usuario_permissoes (
    id              SERIAL PRIMARY KEY,
    tipo_usuario    VARCHAR(50) NOT NULL,
    permissao_id    INTEGER NOT NULL REFERENCES people.permissoes(id) ON DELETE CASCADE,
    concedido       BOOLEAN DEFAULT TRUE,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por  INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    UNIQUE (tipo_usuario, permissao_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_tipo_permissoes_tipo      ON people.tipo_usuario_permissoes(tipo_usuario);
CREATE INDEX IF NOT EXISTS idx_bt_tipo_permissoes_permissao ON people.tipo_usuario_permissoes(permissao_id);

-- Trigger de atualização do timestamp (depende de people.atualizar_timestamp())
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'tr_tipo_usuario_permissoes_atualizado_em'
    ) THEN
        CREATE TRIGGER tr_tipo_usuario_permissoes_atualizado_em
        BEFORE UPDATE ON people.tipo_usuario_permissoes
        FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();
    END IF;
END$$;

-- =====================================================
-- SEED: catálogo de 69 permissões (ordenado por id)
-- =====================================================
INSERT INTO people.permissoes (id, codigo, nome, modulo, acao, descricao) VALUES
  ( 1, 'colaboradores:listar',              'Listar Colaboradores',         'colaboradores',   'listar',              'Visualizar lista de colaboradores'),
  ( 2, 'colaboradores:obter',               'Ver Colaborador',              'colaboradores',   'obter',               'Visualizar detalhes de um colaborador'),
  ( 3, 'colaboradores:criar',               'Criar Colaborador',            'colaboradores',   'criar',               'Cadastrar novo colaborador'),
  ( 4, 'colaboradores:atualizar',           'Atualizar Colaborador',        'colaboradores',   'atualizar',           'Editar dados de colaborador'),
  ( 5, 'colaboradores:excluir',             'Excluir Colaborador',          'colaboradores',   'excluir',             'Remover/inativar colaborador'),
  ( 6, 'cargos:listar',                     'Listar Cargos',                'cargos',          'listar',              'Visualizar lista de cargos'),
  ( 7, 'cargos:criar',                      'Criar Cargo',                  'cargos',          'criar',               'Cadastrar novo cargo'),
  ( 8, 'cargos:atualizar',                  'Atualizar Cargo',              'cargos',          'atualizar',           'Editar dados de cargo'),
  ( 9, 'cargos:excluir',                    'Excluir Cargo',                'cargos',          'excluir',             'Remover cargo'),
  (10, 'departamentos:listar',              'Listar Departamentos',         'departamentos',   'listar',              'Visualizar lista de departamentos'),
  (11, 'departamentos:criar',               'Criar Departamento',           'departamentos',   'criar',               'Cadastrar novo departamento'),
  (12, 'departamentos:atualizar',           'Atualizar Departamento',       'departamentos',   'atualizar',           'Editar dados de departamento'),
  (13, 'departamentos:excluir',             'Excluir Departamento',         'departamentos',   'excluir',             'Remover departamento'),
  (14, 'jornadas:listar',                   'Listar Jornadas',              'jornadas',        'listar',              'Visualizar lista de jornadas'),
  (15, 'jornadas:criar',                    'Criar Jornada',                'jornadas',        'criar',               'Cadastrar nova jornada'),
  (16, 'jornadas:atualizar',                'Atualizar Jornada',            'jornadas',        'atualizar',           'Editar dados de jornada'),
  (17, 'jornadas:excluir',                  'Excluir Jornada',              'jornadas',        'excluir',             'Remover jornada'),
  (19, 'marcacoes:listar',                  'Listar Marcações',             'marcacoes',       'listar',              'Visualizar marcações de ponto'),
  (20, 'marcacoes:listar_todos',            'Listar Todas Marcações',       'marcacoes',       'listar_todos',        'Visualizar marcações de todos os colaboradores'),
  (21, 'marcacoes:criar',                   'Criar Marcação Manual',        'marcacoes',       'criar',               'Registrar marcação manual para outro colaborador'),
  (22, 'marcacoes:atualizar',               'Atualizar Marcação',           'marcacoes',       'atualizar',           'Editar marcação existente'),
  (23, 'marcacoes:excluir',                 'Excluir Marcação',             'marcacoes',       'excluir',             'Remover marcação'),
  (24, 'marcacoes:registrar',               'Registrar Ponto',              'marcacoes',       'registrar',           'Bater ponto próprio (entrada/saída)'),
  (25, 'solicitacoes:listar',               'Listar Solicitações',          'solicitacoes',    'listar',              'Visualizar solicitações'),
  (26, 'solicitacoes:listar_todos',         'Listar Todas Solicitações',    'solicitacoes',    'listar_todos',        'Visualizar solicitações de todos'),
  (27, 'solicitacoes:criar',                'Criar Solicitação',            'solicitacoes',    'criar',               'Criar nova solicitação'),
  (28, 'solicitacoes:aprovar',              'Aprovar Solicitação',          'solicitacoes',    'aprovar',             'Aprovar/rejeitar solicitações'),
  (29, 'banco_horas:listar',                'Ver Banco de Horas',           'banco_horas',     'listar',              'Visualizar banco de horas'),
  (30, 'banco_horas:listar_todos',          'Ver Banco Horas Todos',        'banco_horas',     'listar_todos',        'Visualizar banco de horas de todos'),
  (31, 'banco_horas:ajustar',               'Ajustar Banco de Horas',       'banco_horas',     'ajustar',             'Criar ajustes manuais no banco de horas'),
  (32, 'horas_extras:listar',               'Listar Horas Extras',          'horas_extras',    'listar',              'Visualizar horas extras'),
  (33, 'horas_extras:aprovar',              'Aprovar Horas Extras',         'horas_extras',    'aprovar',             'Aprovar solicitações de horas extras'),
  (34, 'horas_extras:configurar',           'Configurar Horas Extras',      'horas_extras',    'configurar',          'Alterar parâmetros de horas extras'),
  (35, 'localizacoes:listar',               'Listar Localizações',          'localizacoes',    'listar',              'Visualizar localizações'),
  (36, 'localizacoes:criar',                'Criar Localização',            'localizacoes',    'criar',               'Cadastrar nova localização'),
  (37, 'localizacoes:atualizar',            'Atualizar Localização',        'localizacoes',    'atualizar',           'Editar localização'),
  (38, 'localizacoes:excluir',              'Excluir Localização',          'localizacoes',    'excluir',             'Remover localização'),
  (39, 'feriados:listar',                   'Listar Feriados',              'feriados',        'listar',              'Visualizar feriados'),
  (40, 'feriados:criar',                    'Criar Feriado',                'feriados',        'criar',               'Cadastrar novo feriado'),
  (41, 'feriados:atualizar',                'Atualizar Feriado',            'feriados',        'atualizar',           'Editar feriado'),
  (42, 'feriados:excluir',                  'Excluir Feriado',              'feriados',        'excluir',             'Remover feriado'),
  (43, 'notificacoes:listar',               'Ver Notificações',             'notificacoes',    'listar',              'Visualizar notificações'),
  (44, 'notificacoes:enviar',               'Enviar Notificações',          'notificacoes',    'enviar',              'Enviar notificações para colaboradores'),
  (45, 'configuracoes:obter',               'Ver Configurações',            'configuracoes',   'obter',               'Visualizar configurações do sistema'),
  (46, 'configuracoes:atualizar',           'Atualizar Configurações',      'configuracoes',   'atualizar',           'Alterar configurações do sistema'),
  (47, 'relatorios:gerar',                  'Gerar Relatórios',             'relatorios',      'gerar',               'Gerar e exportar relatórios'),
  (48, 'relatorios:espelho_ponto',          'Espelho de Ponto',             'relatorios',      'espelho_ponto',       'Gerar espelho de ponto'),
  (51, 'api_keys:listar',                   'Listar API Keys',              'api_keys',        'listar',              'Visualizar chaves de API'),
  (52, 'api_keys:criar',                    'Criar API Key',                'api_keys',        'criar',               'Criar nova chave de API'),
  (53, 'api_keys:revogar',                  'Revogar API Key',              'api_keys',        'revogar',             'Revogar chave de API'),
  (54, 'auditoria:listar',                  'Ver Auditoria',                'auditoria',       'listar',              'Visualizar logs de auditoria'),
  (55, 'permissoes:listar',                 'Listar Permissões',            'permissoes',      'listar',              'Visualizar permissões do sistema'),
  (56, 'permissoes:gerenciar',              'Gerenciar Permissões',         'permissoes',      'gerenciar',           'Alterar permissões de tipos de usuário'),
  (57, 'dashboard:ver',                     'Ver Dashboard',                'dashboard',       'ver',                 'Acessar painel de visão geral'),
  (59, 'empresas:ver',                      'Ver Empresas',                 'empresas',        'ver',                 'Listar e visualizar empresas'),
  (60, 'empresas:criar',                    'Criar Empresa',                'empresas',        'criar',               'Cadastrar novas empresas'),
  (61, 'empresas:editar',                   'Editar Empresa',               'empresas',        'editar',              'Editar dados de empresas'),
  (62, 'empresas:excluir',                  'Excluir Empresa',              'empresas',        'excluir',             'Remover empresas'),
  (63, 'acompanhamento:ver',                'Ver Acompanhamento',           'acompanhamento',  'ver',                 'Visualizar acompanhamento de jornada'),
  (64, 'acompanhamento:ver_todos',          'Ver Todos os Acompanhamentos', 'acompanhamento',  'ver_todos',           'Ver acompanhamento de todos os colaboradores'),
  (65, 'ajustes_jornada:ver',               'Ver Ajustes de Jornada',       'ajustes_jornada', 'ver',                 'Visualizar ajustes de jornada'),
  (66, 'ajustes_jornada:editar',            'Editar Ajustes de Jornada',    'ajustes_jornada', 'editar',              'Criar e editar ajustes de jornada'),
  (67, 'escalas:ver',                       'Ver Escalas',                  'escalas',         'ver',                 'Visualizar gestão de escalas'),
  (68, 'escalas:gerenciar',                 'Gerenciar Escalas',            'escalas',         'gerenciar',           'Criar e editar escalas de trabalho'),
  (69, 'colaboradores:atribuir_jornada',    'Atribuir Jornada',             'colaboradores',   'atribuir_jornada',    'Atribuir horários/jornadas a colaboradores'),
  (70, 'dispositivos:ver',                  'Ver Dispositivos',             'dispositivos',    'ver',                 'Listar e visualizar dispositivos cadastrados'),
  (71, 'dispositivos:criar',                'Cadastrar Dispositivo',        'dispositivos',    'criar',               'Cadastrar novos dispositivos no sistema'),
  (72, 'dispositivos:editar',               'Editar Dispositivo',           'dispositivos',    'editar',              'Editar, inativar dispositivos e gerar novo código'),
  (73, 'colaboradores:gerenciar_biometria', 'Gerenciar Biometria',          'colaboradores',   'gerenciar_biometria', 'Cadastrar e remover biometria facial de colaboradores')
ON CONFLICT (codigo) DO NOTHING;

-- Reposiciona a sequence pro próximo id após o maior existente
SELECT setval('people.bt_permissoes_id_seq', COALESCE((SELECT MAX(id) FROM people.permissoes), 1), true);

-- =====================================================
-- SEED: vínculos tipo_usuario -> permissão (concedidas)
-- admin: 69 permissões (todas)
-- gestor: 13 permissões
-- gerente / supervisor / coordenador / colaborador: nenhuma
-- =====================================================
INSERT INTO people.tipo_usuario_permissoes (tipo_usuario, permissao_id, concedido)
SELECT 'admin', id, TRUE FROM people.permissoes
ON CONFLICT (tipo_usuario, permissao_id) DO NOTHING;

INSERT INTO people.tipo_usuario_permissoes (tipo_usuario, permissao_id, concedido)
SELECT 'gestor', p.id, TRUE
FROM people.permissoes p
WHERE p.codigo IN (
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
    'solicitacoes:listar_todos'
)
ON CONFLICT (tipo_usuario, permissao_id) DO NOTHING;
