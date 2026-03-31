-- =====================================================
-- BluePoint - Sistema de Gestão de Ponto
-- Script de criação do schema e tabelas
-- =====================================================

-- Criar schema
CREATE SCHEMA IF NOT EXISTS people;

-- Definir search_path para usar o schema people
SET search_path TO people;

-- =====================================================
-- TIPOS ENUMERADOS
-- =====================================================

CREATE TYPE people.tipo_usuario AS ENUM ('colaborador', 'gestor', 'gerente', 'supervisor', 'coordenador', 'admin');
CREATE TYPE people.status_registro AS ENUM ('ativo', 'inativo');
CREATE TYPE people.tipo_marcacao AS ENUM ('entrada', 'saida', 'almoco', 'retorno');
CREATE TYPE people.metodo_marcacao AS ENUM ('app', 'web', 'biometria');
CREATE TYPE people.tipo_movimentacao_horas AS ENUM ('credito', 'debito', 'compensacao', 'ajuste');
CREATE TYPE people.status_solicitacao AS ENUM ('pendente', 'aprovada', 'rejeitada', 'cancelada');
CREATE TYPE people.tipo_solicitacao AS ENUM ('ajuste_ponto', 'ferias', 'atestado', 'ausencia', 'outros');
CREATE TYPE people.tipo_anexo AS ENUM ('atestado', 'comprovante', 'documento', 'foto', 'outros');
CREATE TYPE people.tipo_localizacao AS ENUM ('matriz', 'filial', 'obra', 'cliente', 'outros');
CREATE TYPE people.tipo_feriado AS ENUM ('nacional', 'estadual', 'municipal', 'empresa');
CREATE TYPE people.tipo_notificacao AS ENUM ('sistema', 'solicitacao', 'marcacao', 'alerta', 'lembrete');

-- =====================================================
-- TABELAS PRINCIPAIS
-- =====================================================

-- Tabela de Departamentos
CREATE TABLE people.departamentos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    gestor_id INTEGER,
    status people.status_registro DEFAULT 'ativo',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_departamentos_status ON people.departamentos(status);
CREATE INDEX idx_bt_departamentos_gestor ON people.departamentos(gestor_id);

-- Tabela de Jornadas de Trabalho
CREATE TABLE people.jornadas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    carga_horaria_semanal DECIMAL(5,2) DEFAULT 44.00,
    tolerancia_entrada INTEGER DEFAULT 10, -- minutos
    tolerancia_saida INTEGER DEFAULT 10, -- minutos
    status people.status_registro DEFAULT 'ativo',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_jornadas_status ON people.jornadas(status);

-- Tabela de Horários da Jornada (dias da semana)
CREATE TABLE people.jornada_horarios (
    id SERIAL PRIMARY KEY,
    jornada_id INTEGER NOT NULL REFERENCES people.jornadas(id) ON DELETE CASCADE,
    dia_semana SMALLINT CHECK (dia_semana BETWEEN 0 AND 6), -- 0=domingo, 6=sábado (para jornada simples)
    sequencia SMALLINT, -- ordem no ciclo (para jornada circular): 1, 2, 3...
    quantidade_dias SMALLINT DEFAULT 1, -- quantos dias esse bloco dura (para circular)
    dias_semana JSONB DEFAULT '[]', -- [1, 2, 3, 4, 5] = seg a sex (para circular)
    folga BOOLEAN DEFAULT FALSE,
    periodos JSONB DEFAULT '[]', -- [{"entrada": "08:00", "saida": "12:00"}, {"entrada": "13:00", "saida": "18:00"}]
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_jornada_horarios_jornada ON people.jornada_horarios(jornada_id);

-- Tabela de Colaboradores
CREATE TABLE people.colaboradores (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    senha_hash VARCHAR(255) NOT NULL,
    cpf VARCHAR(14) NOT NULL UNIQUE,
    rg VARCHAR(20),
    telefone VARCHAR(20),
    cargo_id INTEGER,
    tipo people.tipo_usuario DEFAULT 'colaborador',
    departamento_id INTEGER REFERENCES people.departamentos(id) ON DELETE SET NULL,
    jornada_id INTEGER REFERENCES people.jornadas(id) ON DELETE SET NULL,
    data_admissao DATE NOT NULL,
    data_nascimento DATE,
    status people.status_registro DEFAULT 'ativo',
    foto_url TEXT,
    face_registrada BOOLEAN DEFAULT FALSE,
    -- Endereço
    endereco_cep VARCHAR(10),
    endereco_logradouro VARCHAR(255),
    endereco_numero VARCHAR(20),
    endereco_complemento VARCHAR(100),
    endereco_bairro VARCHAR(100),
    endereco_cidade VARCHAR(100),
    endereco_estado VARCHAR(2),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_colaboradores_email ON people.colaboradores(email);
CREATE INDEX idx_bt_colaboradores_cpf ON people.colaboradores(cpf);
CREATE INDEX idx_bt_colaboradores_departamento ON people.colaboradores(departamento_id);
CREATE INDEX idx_bt_colaboradores_jornada ON people.colaboradores(jornada_id);
CREATE INDEX idx_bt_colaboradores_cargo ON people.colaboradores(cargo_id);
CREATE INDEX idx_bt_colaboradores_status ON people.colaboradores(status);
CREATE INDEX idx_bt_colaboradores_tipo ON people.colaboradores(tipo);

-- Adicionar FK do gestor no departamento após criar colaboradores
ALTER TABLE people.departamentos 
ADD CONSTRAINT fk_departamento_gestor 
FOREIGN KEY (gestor_id) REFERENCES people.colaboradores(id) ON DELETE SET NULL;

-- Adicionar FK do cargo no colaborador (cargos deve existir antes)
ALTER TABLE people.colaboradores
ADD CONSTRAINT fk_colaborador_cargo
FOREIGN KEY (cargo_id) REFERENCES people.cargos(id) ON DELETE SET NULL;

-- Tabela de Tipos de Documento do Colaborador (ASO, EPI, CNH, etc.)
CREATE TABLE people.tipos_documento_colaborador (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nome_exibicao VARCHAR(100) NOT NULL,
    validade_meses INTEGER,
    categoria VARCHAR(20) NOT NULL DEFAULT 'operacional',
    obrigatorio_padrao BOOLEAN NOT NULL DEFAULT true,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_bt_tipos_documento_categoria CHECK (categoria IN ('operacional', 'admissao'))
);

CREATE INDEX idx_bt_tipos_documento_codigo ON people.tipos_documento_colaborador(codigo);
CREATE INDEX idx_bt_tipos_documento_categoria ON people.tipos_documento_colaborador(categoria);

-- Tabela de Documentos do Colaborador
CREATE TABLE people.documentos_colaborador (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    tipo VARCHAR(50) NOT NULL,
    tipo_documento_id INTEGER REFERENCES people.tipos_documento_colaborador(id) ON DELETE SET NULL,
    nome VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    storage_key TEXT,
    tamanho INTEGER,
    data_upload TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_validade DATE
);

CREATE INDEX idx_bt_documentos_colaborador ON people.documentos_colaborador(colaborador_id);
CREATE INDEX idx_bt_documentos_colaborador_tipo ON people.documentos_colaborador(tipo_documento_id);
CREATE INDEX idx_bt_documentos_colaborador_validade ON people.documentos_colaborador(data_validade);

-- Obrigatoriedade por cargo (ex.: vendedor interno sem CNH/Direção Defensiva). Requer cargos.
CREATE TABLE people.cargo_tipo_documento (
    cargo_id INTEGER NOT NULL REFERENCES people.cargos(id) ON DELETE CASCADE,
    tipo_documento_id INTEGER NOT NULL REFERENCES people.tipos_documento_colaborador(id) ON DELETE CASCADE,
    obrigatorio BOOLEAN NOT NULL,
    PRIMARY KEY (cargo_id, tipo_documento_id)
);

CREATE INDEX idx_bt_cargo_tipo_documento_cargo ON people.cargo_tipo_documento(cargo_id);
CREATE INDEX idx_bt_cargo_tipo_documento_tipo ON people.cargo_tipo_documento(tipo_documento_id);

-- Seed tipos de documento (ASO, EPI, CNH, etc.)
INSERT INTO people.tipos_documento_colaborador (codigo, nome_exibicao, validade_meses, categoria, obrigatorio_padrao)
VALUES
  ('aso', 'ASO', 12, 'operacional', true),
  ('epi', 'EPI', 12, 'operacional', true),
  ('direcao_defensiva', 'Direção Defensiva', 12, 'operacional', true),
  ('cnh', 'CNH', 60, 'operacional', true),
  ('nr35', 'NR35', 12, 'operacional', true),
  ('outros', 'Outros Documentos', NULL, 'operacional', false);

-- Tabela de Marcações de Ponto
CREATE TABLE people.marcacoes (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    data_hora TIMESTAMP NOT NULL,
    tipo people.tipo_marcacao NOT NULL,
    latitude DECIMAL(10,8),
    longitude DECIMAL(11,8),
    endereco TEXT,
    metodo people.metodo_marcacao DEFAULT 'web',
    foto_url TEXT,
    observacao TEXT,
    justificativa TEXT,
    criado_por INTEGER REFERENCES people.colaboradores(id), -- para marcações manuais
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_marcacoes_colaborador ON people.marcacoes(colaborador_id);
CREATE INDEX idx_bt_marcacoes_data_hora ON people.marcacoes(data_hora);
CREATE INDEX idx_bt_marcacoes_tipo ON people.marcacoes(tipo);
CREATE INDEX idx_bt_marcacoes_data ON people.marcacoes((data_hora::date));

-- Tabela de Banco de Horas
CREATE TABLE people.banco_horas (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    tipo people.tipo_movimentacao_horas NOT NULL,
    descricao TEXT,
    horas DECIMAL(5,2) NOT NULL, -- positivo=crédito, negativo=débito
    saldo_anterior DECIMAL(6,2) NOT NULL DEFAULT 0,
    saldo_atual DECIMAL(6,2) NOT NULL DEFAULT 0,
    observacao TEXT,
    criado_por INTEGER REFERENCES people.colaboradores(id),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_banco_horas_colaborador ON people.banco_horas(colaborador_id);
CREATE INDEX idx_bt_banco_horas_data ON people.banco_horas(data);
CREATE INDEX idx_bt_banco_horas_tipo ON people.banco_horas(tipo);

-- Tabela de Solicitações
CREATE TABLE people.solicitacoes (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    tipo people.tipo_solicitacao NOT NULL,
    status people.status_solicitacao DEFAULT 'pendente',
    data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_evento DATE,
    data_evento_fim DATE, -- para períodos (férias, atestados)
    descricao TEXT,
    justificativa TEXT,
    dados_adicionais JSONB, -- dados específicos por tipo
    gestor_id INTEGER REFERENCES people.colaboradores(id), -- gestor responsável (usado em hora_extra)
    aprovador_id INTEGER REFERENCES people.colaboradores(id),
    data_aprovacao TIMESTAMP,
    motivo_rejeicao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_solicitacoes_colaborador ON people.solicitacoes(colaborador_id);
CREATE INDEX idx_bt_solicitacoes_tipo ON people.solicitacoes(tipo);
CREATE INDEX idx_bt_solicitacoes_status ON people.solicitacoes(status);
CREATE INDEX idx_bt_solicitacoes_data ON people.solicitacoes(data_solicitacao);
CREATE INDEX idx_bt_solicitacoes_aprovador ON people.solicitacoes(aprovador_id);
CREATE INDEX idx_bt_solicitacoes_gestor ON people.solicitacoes(gestor_id);

-- Tabela de Histórico de Status das Solicitações
CREATE TABLE people.solicitacoes_historico (
    id SERIAL PRIMARY KEY,
    solicitacao_id INTEGER NOT NULL REFERENCES people.solicitacoes(id) ON DELETE CASCADE,
    status_anterior people.status_solicitacao,
    status_novo people.status_solicitacao NOT NULL,
    usuario_id INTEGER REFERENCES people.colaboradores(id),
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_solicitacoes_historico_solicitacao ON people.solicitacoes_historico(solicitacao_id);

-- Tabela de Anexos
CREATE TABLE people.anexos (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    solicitacao_id INTEGER REFERENCES people.solicitacoes(id) ON DELETE CASCADE,
    tipo people.tipo_anexo DEFAULT 'documento',
    nome VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    tamanho INTEGER,
    descricao TEXT,
    data_upload TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_anexos_colaborador ON people.anexos(colaborador_id);
CREATE INDEX idx_bt_anexos_solicitacao ON people.anexos(solicitacao_id);

-- Tabela de Localizações (Geofence)
CREATE TABLE people.localizacoes (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    tipo people.tipo_localizacao DEFAULT 'matriz',
    endereco_cep VARCHAR(10),
    endereco_logradouro VARCHAR(255),
    endereco_numero VARCHAR(20),
    endereco_complemento VARCHAR(100),
    endereco_bairro VARCHAR(100),
    endereco_cidade VARCHAR(100),
    endereco_estado VARCHAR(2),
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    raio_permitido INTEGER DEFAULT 100, -- metros
    horarios_funcionamento JSONB,
    status people.status_registro DEFAULT 'ativo',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_localizacoes_status ON people.localizacoes(status);
CREATE INDEX idx_bt_localizacoes_tipo ON people.localizacoes(tipo);

-- Tabela de Feriados
CREATE TABLE people.feriados (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    data DATE NOT NULL,
    tipo people.tipo_feriado DEFAULT 'nacional',
    recorrente BOOLEAN DEFAULT FALSE,
    abrangencia VARCHAR(100), -- ex: "SP", "São Paulo", etc.
    descricao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_feriados_data ON people.feriados(data);
CREATE INDEX idx_bt_feriados_tipo ON people.feriados(tipo);
CREATE INDEX idx_bt_feriados_recorrente ON people.feriados(recorrente);

-- Tabela de Notificações
CREATE TABLE people.notificacoes (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    tipo people.tipo_notificacao DEFAULT 'sistema',
    titulo VARCHAR(255) NOT NULL,
    mensagem TEXT NOT NULL,
    lida BOOLEAN DEFAULT FALSE,
    data_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_leitura TIMESTAMP,
    link TEXT,
    metadados JSONB
);

CREATE INDEX idx_bt_notificacoes_usuario ON people.notificacoes(usuario_id);
CREATE INDEX idx_bt_notificacoes_lida ON people.notificacoes(lida);
CREATE INDEX idx_bt_notificacoes_data ON people.notificacoes(data_envio);

-- Tabela de Refresh Tokens
CREATE TABLE people.refresh_tokens (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    token VARCHAR(500) NOT NULL UNIQUE,
    data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_expiracao TIMESTAMP NOT NULL,
    revogado BOOLEAN DEFAULT FALSE,
    revogado_em TIMESTAMP
);

CREATE INDEX idx_bt_refresh_tokens_usuario ON people.refresh_tokens(usuario_id);
CREATE INDEX idx_bt_refresh_tokens_token ON people.refresh_tokens(token);

-- Tabela de Tokens de Recuperação de Senha
CREATE TABLE people.tokens_recuperacao (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_expiracao TIMESTAMP NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    usado_em TIMESTAMP
);

CREATE INDEX idx_bt_tokens_recuperacao_token ON people.tokens_recuperacao(token);
CREATE INDEX idx_bt_tokens_recuperacao_usuario ON people.tokens_recuperacao(usuario_id);

-- Tabela de Configurações da Empresa
CREATE TABLE people.configuracoes_empresa (
    id SERIAL PRIMARY KEY,
    razao_social VARCHAR(255),
    nome_fantasia VARCHAR(255),
    cnpj VARCHAR(18),
    endereco_cep VARCHAR(10),
    endereco_logradouro VARCHAR(255),
    endereco_numero VARCHAR(20),
    endereco_complemento VARCHAR(100),
    endereco_bairro VARCHAR(100),
    endereco_cidade VARCHAR(100),
    endereco_estado VARCHAR(2),
    telefone VARCHAR(20),
    email VARCHAR(255),
    logo_url TEXT,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Configurações do Sistema
CREATE TABLE people.configuracoes (
    id SERIAL PRIMARY KEY,
    categoria VARCHAR(50) NOT NULL,
    chave VARCHAR(100) NOT NULL,
    valor TEXT,
    descricao TEXT,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(categoria, chave)
);

CREATE INDEX idx_bt_configuracoes_categoria ON people.configuracoes(categoria);

-- Tabela de Biometria Facial
CREATE TABLE people.biometria_facial (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    encoding BYTEA, -- dados do encoding facial
    qualidade DECIMAL(3,2), -- 0.00 a 1.00
    foto_referencia_url TEXT,
    data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_bt_biometria_facial_colaborador ON people.biometria_facial(colaborador_id);

-- Tabela de Logs de Auditoria
CREATE TABLE people.auditoria (
    id SERIAL PRIMARY KEY,
    data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    usuario_id INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    acao VARCHAR(50) NOT NULL, -- CREATE, UPDATE, DELETE, LOGIN, LOGOUT, etc.
    modulo VARCHAR(50) NOT NULL, -- colaboradores, marcacoes, solicitacoes, etc.
    descricao TEXT,
    ip VARCHAR(45),
    user_agent TEXT,
    dados_anteriores JSONB,
    dados_novos JSONB,
    metadados JSONB
);

CREATE INDEX idx_bt_auditoria_data ON people.auditoria(data_hora);
CREATE INDEX idx_bt_auditoria_usuario ON people.auditoria(usuario_id);
CREATE INDEX idx_bt_auditoria_acao ON people.auditoria(acao);
CREATE INDEX idx_bt_auditoria_modulo ON people.auditoria(modulo);

-- Tabela de Histórico de Jornadas do Colaborador (para manter histórico de mudanças)
CREATE TABLE people.colaborador_jornadas_historico (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    jornada_id INTEGER NOT NULL REFERENCES people.jornadas(id) ON DELETE CASCADE,
    data_inicio DATE NOT NULL,
    data_fim DATE,
    criado_por INTEGER REFERENCES people.colaboradores(id),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_colaborador_jornadas_colaborador ON people.colaborador_jornadas_historico(colaborador_id);
CREATE INDEX idx_bt_colaborador_jornadas_jornada ON people.colaborador_jornadas_historico(jornada_id);

-- Tabela de Tipos de Solicitação (configurável)
CREATE TABLE people.tipos_solicitacao (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    requer_anexo BOOLEAN DEFAULT FALSE,
    campos_adicionais JSONB, -- definição dos campos extras
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de vinculação localização x departamento
CREATE TABLE people.localizacao_departamentos (
    id SERIAL PRIMARY KEY,
    localizacao_id INTEGER NOT NULL REFERENCES people.localizacoes(id) ON DELETE CASCADE,
    departamento_id INTEGER NOT NULL REFERENCES people.departamentos(id) ON DELETE CASCADE,
    UNIQUE(localizacao_id, departamento_id)
);

-- =====================================================
-- FUNÇÕES E TRIGGERS
-- =====================================================

-- Função para atualizar timestamp de atualização
CREATE OR REPLACE FUNCTION people.atualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para atualização automática de timestamp
CREATE TRIGGER tr_colaboradores_atualizado_em
    BEFORE UPDATE ON people.colaboradores
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_departamentos_atualizado_em
    BEFORE UPDATE ON people.departamentos
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_jornadas_atualizado_em
    BEFORE UPDATE ON people.jornadas
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_marcacoes_atualizado_em
    BEFORE UPDATE ON people.marcacoes
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_solicitacoes_atualizado_em
    BEFORE UPDATE ON people.solicitacoes
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_localizacoes_atualizado_em
    BEFORE UPDATE ON people.localizacoes
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_feriados_atualizado_em
    BEFORE UPDATE ON people.feriados
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_configuracoes_atualizado_em
    BEFORE UPDATE ON people.configuracoes
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_configuracoes_empresa_atualizado_em
    BEFORE UPDATE ON people.configuracoes_empresa
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

CREATE TRIGGER tr_biometria_facial_atualizado_em
    BEFORE UPDATE ON people.biometria_facial
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

-- =====================================================
-- DADOS INICIAIS
-- =====================================================

-- Configurações padrão do sistema
INSERT INTO people.configuracoes (categoria, chave, valor, descricao) VALUES
    ('ponto', 'tolerancia_entrada', '10', 'Tolerância em minutos para entrada'),
    ('ponto', 'tolerancia_saida', '10', 'Tolerância em minutos para saída'),
    ('ponto', 'tolerancia_intervalo', '5', 'Tolerância em minutos para intervalo'),
    ('ponto', 'considerar_fim_semana', 'false', 'Considerar marcações em fins de semana'),
    ('ponto', 'considerar_feriados', 'true', 'Considerar marcações em feriados'),
    ('notificacoes', 'email_ativo', 'true', 'Enviar notificações por email'),
    ('notificacoes', 'push_ativo', 'true', 'Enviar notificações push'),
    ('geral', 'fuso_horario', 'America/Sao_Paulo', 'Fuso horário padrão'),
    ('geral', 'formato_data', 'DD/MM/YYYY', 'Formato de data padrão'),
    ('geral', 'formato_hora', 'HH:mm', 'Formato de hora padrão');

-- Tipos de solicitação padrão
INSERT INTO people.tipos_solicitacao (codigo, nome, descricao, requer_anexo, campos_adicionais) VALUES
    ('ajuste_ponto', 'Ajuste de Ponto', 'Solicitação de ajuste em marcação de ponto', false, '{"marcacaoId": "number", "dataHoraCorreta": "datetime", "motivo": "string"}'),
    ('ferias', 'Férias', 'Solicitação de período de férias', false, '{"dataInicio": "date", "dataFim": "date", "dias": "number"}'),
    ('atestado', 'Atestado Médico', 'Envio de atestado médico', true, '{"cid": "string", "dataInicio": "date", "dataFim": "date"}'),
    ('ausencia', 'Justificativa de Ausência', 'Justificativa para ausência/falta', false, '{"data": "date", "motivo": "string"}'),
    ('outros', 'Outros', 'Outras solicitações', false, null);

-- Feriados nacionais (2026)
INSERT INTO people.feriados (nome, data, tipo, recorrente, abrangencia) VALUES
    ('Confraternização Universal', '2026-01-01', 'nacional', true, 'Brasil'),
    ('Carnaval', '2026-02-16', 'nacional', false, 'Brasil'),
    ('Carnaval', '2026-02-17', 'nacional', false, 'Brasil'),
    ('Sexta-feira Santa', '2026-04-03', 'nacional', false, 'Brasil'),
    ('Tiradentes', '2026-04-21', 'nacional', true, 'Brasil'),
    ('Dia do Trabalho', '2026-05-01', 'nacional', true, 'Brasil'),
    ('Corpus Christi', '2026-06-04', 'nacional', false, 'Brasil'),
    ('Independência do Brasil', '2026-09-07', 'nacional', true, 'Brasil'),
    ('Nossa Senhora Aparecida', '2026-10-12', 'nacional', true, 'Brasil'),
    ('Finados', '2026-11-02', 'nacional', true, 'Brasil'),
    ('Proclamação da República', '2026-11-15', 'nacional', true, 'Brasil'),
    ('Natal', '2026-12-25', 'nacional', true, 'Brasil');

-- Criar registro inicial de configurações da empresa (vazio para ser preenchido)
INSERT INTO people.configuracoes_empresa (id) VALUES (1);

-- =====================================================
-- VIEWS ÚTEIS
-- =====================================================

-- View de colaboradores com departamento, cargo e jornada
CREATE OR REPLACE VIEW people.vw_colaboradores_completo AS
SELECT 
    c.id,
    c.nome,
    c.email,
    c.cpf,
    c.rg,
    c.telefone,
    c.tipo,
    c.status,
    c.foto_url,
    c.face_registrada,
    c.data_admissao,
    c.data_nascimento,
    c.endereco_cep,
    c.endereco_logradouro,
    c.endereco_numero,
    c.endereco_complemento,
    c.endereco_bairro,
    c.endereco_cidade,
    c.endereco_estado,
    c.cargo_id,
    cg.nome as cargo_nome,
    d.id as departamento_id,
    d.nome as departamento_nome,
    j.id as jornada_id,
    j.nome as jornada_nome,
    c.criado_em,
    c.atualizado_em
FROM people.colaboradores c
LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
LEFT JOIN people.departamentos d ON c.departamento_id = d.id
LEFT JOIN people.jornadas j ON c.jornada_id = j.id;

-- View de marcações do dia atual
CREATE OR REPLACE VIEW people.vw_marcacoes_hoje AS
SELECT 
    m.id,
    m.colaborador_id,
    c.nome as colaborador_nome,
    d.nome as departamento_nome,
    m.data_hora,
    m.tipo,
    m.metodo,
    m.latitude,
    m.longitude,
    m.endereco,
    m.foto_url,
    m.observacao
FROM people.marcacoes m
JOIN people.colaboradores c ON m.colaborador_id = c.id
LEFT JOIN people.departamentos d ON c.departamento_id = d.id
WHERE DATE(m.data_hora) = CURRENT_DATE
ORDER BY m.data_hora DESC;

-- View de solicitações pendentes
CREATE OR REPLACE VIEW people.vw_solicitacoes_pendentes AS
SELECT 
    s.id,
    s.tipo,
    s.status,
    s.data_solicitacao,
    s.data_evento,
    s.descricao,
    s.justificativa,
    c.id as colaborador_id,
    c.nome as colaborador_nome,
    d.id as departamento_id,
    d.nome as departamento_nome
FROM people.solicitacoes s
JOIN people.colaboradores c ON s.colaborador_id = c.id
LEFT JOIN people.departamentos d ON c.departamento_id = d.id
WHERE s.status = 'pendente'
ORDER BY s.data_solicitacao ASC;

-- View de saldo de banco de horas por colaborador
CREATE OR REPLACE VIEW people.vw_saldo_banco_horas AS
SELECT 
    c.id as colaborador_id,
    c.nome as colaborador_nome,
    COALESCE(
        (SELECT saldo_atual 
         FROM people.banco_horas 
         WHERE colaborador_id = c.id 
         ORDER BY criado_em DESC 
         LIMIT 1), 
        0
    ) as saldo_atual,
    (SELECT MAX(criado_em) 
     FROM people.banco_horas 
     WHERE colaborador_id = c.id) as ultima_atualizacao
FROM people.colaboradores c
WHERE c.status = 'ativo';

-- =====================================================
-- COMENTÁRIOS NAS TABELAS
-- =====================================================

COMMENT ON TABLE people.colaboradores IS 'Tabela de colaboradores/usuários do sistema';
COMMENT ON TABLE people.departamentos IS 'Departamentos da empresa';
COMMENT ON TABLE people.jornadas IS 'Jornadas de trabalho definidas';
COMMENT ON TABLE people.jornada_horarios IS 'Horários de cada dia da semana para uma jornada';
COMMENT ON TABLE people.marcacoes IS 'Marcações de ponto dos colaboradores';
COMMENT ON TABLE people.banco_horas IS 'Movimentações do banco de horas';
COMMENT ON TABLE people.solicitacoes IS 'Solicitações diversas (ajustes, férias, atestados)';
COMMENT ON TABLE people.anexos IS 'Arquivos anexados a solicitações';
COMMENT ON TABLE people.localizacoes IS 'Localizações permitidas para registro de ponto (geofence)';
COMMENT ON TABLE people.feriados IS 'Feriados cadastrados no sistema';
COMMENT ON TABLE people.notificacoes IS 'Notificações enviadas aos usuários';
COMMENT ON TABLE people.refresh_tokens IS 'Tokens de refresh para autenticação JWT';
COMMENT ON TABLE people.tokens_recuperacao IS 'Tokens para recuperação de senha';
COMMENT ON TABLE people.configuracoes IS 'Configurações gerais do sistema';
COMMENT ON TABLE people.configuracoes_empresa IS 'Dados cadastrais da empresa';
COMMENT ON TABLE people.biometria_facial IS 'Dados de biometria facial dos colaboradores';
COMMENT ON TABLE people.auditoria IS 'Logs de auditoria do sistema';

-- =====================================================
-- TABELA DE PARÂMETROS DE HORA EXTRA
-- =====================================================

-- Parâmetros globais de tolerância de hora extra
CREATE TABLE people.parametros_hora_extra (
    id SERIAL PRIMARY KEY,
    minutos_tolerancia INTEGER NOT NULL DEFAULT 10,
    dias_permitidos_por_mes INTEGER NOT NULL DEFAULT 2,
    ativo BOOLEAN DEFAULT TRUE,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL
);

COMMENT ON TABLE people.parametros_hora_extra IS 'Parâmetros globais de tolerância de hora extra';

CREATE TRIGGER tr_parametros_hora_extra_atualizado_em
    BEFORE UPDATE ON people.parametros_hora_extra
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

-- Histórico de tolerância de hora extra por colaborador
CREATE TABLE people.historico_tolerancia_hora_extra (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    minutos_hora_extra INTEGER NOT NULL,
    consumiu_tolerancia BOOLEAN DEFAULT TRUE,
    parametro_id INTEGER REFERENCES people.parametros_hora_extra(id) ON DELETE SET NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(colaborador_id, data)
);

CREATE INDEX idx_bt_hist_tol_he_colaborador ON people.historico_tolerancia_hora_extra(colaborador_id);
CREATE INDEX idx_bt_hist_tol_he_data ON people.historico_tolerancia_hora_extra(data);
CREATE INDEX idx_bt_hist_tol_he_colab_data ON people.historico_tolerancia_hora_extra(colaborador_id, data);

COMMENT ON TABLE people.historico_tolerancia_hora_extra IS 'Histórico de dias em que a tolerância de hora extra foi consumida';

-- Adicionar coluna de origem nas solicitações
ALTER TABLE people.solicitacoes ADD COLUMN IF NOT EXISTS origem VARCHAR(20) DEFAULT 'manual';
CREATE INDEX idx_bt_solicitacoes_origem ON people.solicitacoes(origem);

-- =====================================================
-- TABELA DE CONFIGURAÇÕES DO SISTEMA POR EMPRESA
-- =====================================================

CREATE TABLE people.config_sistema (
    id SERIAL PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES people.empresas(id) ON DELETE CASCADE,
    geral JSONB NOT NULL DEFAULT '{
        "nomeEmpresa": "",
        "fusoHorario": "America/Sao_Paulo",
        "formatoData": "DD/MM/YYYY",
        "formatoHora": "24h",
        "idioma": "pt-BR"
    }'::jsonb,
    ponto JSONB NOT NULL DEFAULT '{
        "toleranciaEntrada": 10,
        "toleranciaSaida": 10,
        "intervaloMinimoMarcacoes": 1,
        "permitirMarcacaoOffline": true,
        "exigirFotoPadrao": true,
        "exigirGeolocalizacaoPadrao": false,
        "raioMaximoGeolocalizacao": 100,
        "permitirMarcacaoForaPerimetro": false,
        "bloquearMarcacaoDuplicada": true,
        "tempoBloqueioDuplicada": 5
    }'::jsonb,
    notificacoes JSONB NOT NULL DEFAULT '{
        "notificarAtrasos": true,
        "notificarFaltasMarcacao": true,
        "notificarHorasExtras": true,
        "notificarAprovacoesPendentes": true,
        "emailNotificacoes": true,
        "pushNotificacoes": true,
        "resumoDiario": false,
        "horarioResumoDiario": "08:00"
    }'::jsonb,
    seguranca JSONB NOT NULL DEFAULT '{
        "tempoSessao": 480,
        "exigirSenhaForte": true,
        "tamanhoMinimoSenha": 8,
        "exigirTrocaSenhaPeriodica": false,
        "diasTrocaSenha": 90,
        "tentativasLoginMax": 5,
        "tempoBloqueioLogin": 15,
        "autenticacaoDoisFatores": false
    }'::jsonb,
    aparencia JSONB NOT NULL DEFAULT '{
        "tema": "claro",
        "corPrimaria": "#2563eb",
        "mostrarLogoSidebar": true,
        "compactarSidebar": false
    }'::jsonb,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL,
    UNIQUE(empresa_id)
);

CREATE INDEX idx_bt_config_sistema_empresa ON people.config_sistema(empresa_id);

COMMENT ON TABLE people.config_sistema IS 'Configurações do sistema por empresa (geral, ponto, notificações, segurança, aparência)';

CREATE TRIGGER tr_config_sistema_atualizado_em
    BEFORE UPDATE ON people.config_sistema
    FOR EACH ROW EXECUTE FUNCTION people.atualizar_timestamp();

-- =====================================================
-- ESPORTES (SESSÕES E INSCRIÇÕES)
-- =====================================================

CREATE TABLE IF NOT EXISTS people.parametros_esportes (
    id SERIAL PRIMARY KEY,
    dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
    hora_inicio TIME NOT NULL,
    total_jogadores INTEGER NOT NULL CHECK (total_jogadores > 0),
    horas_jogo INTEGER NOT NULL CHECK (horas_jogo > 0),
    local VARCHAR(255) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por INTEGER REFERENCES people.colaboradores(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS people.esportes_sessoes (
    id SERIAL PRIMARY KEY,
    data_sessao DATE NOT NULL UNIQUE,
    hora_inicio TIME NOT NULL,
    horas_jogo INTEGER NOT NULL CHECK (horas_jogo > 0),
    local VARCHAR(255) NOT NULL,
    total_vagas INTEGER NOT NULL CHECK (total_vagas > 0),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS people.esportes_inscricoes (
    id SERIAL PRIMARY KEY,
    sessao_id INTEGER NOT NULL REFERENCES people.esportes_sessoes(id) ON DELETE CASCADE,
    colaborador_id INTEGER NOT NULL REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    posicao VARCHAR(20) NOT NULL CHECK (posicao IN ('linha', 'goleiro')),
    confirmado BOOLEAN NOT NULL DEFAULT false,
    confirmado_em TIMESTAMP,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sessao_id, colaborador_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_esportes_sessoes_data ON people.esportes_sessoes(data_sessao);
CREATE INDEX IF NOT EXISTS idx_bt_esportes_inscricoes_sessao ON people.esportes_inscricoes(sessao_id);
CREATE INDEX IF NOT EXISTS idx_bt_esportes_inscricoes_colaborador ON people.esportes_inscricoes(colaborador_id);

-- =====================================================
-- FIM DO SCRIPT
-- =====================================================
