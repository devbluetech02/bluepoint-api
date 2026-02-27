-- =====================================================
-- BluePoint - Sistema de Gestão de Ponto
-- Script de criação do schema e tabelas
-- =====================================================

-- Criar schema
CREATE SCHEMA IF NOT EXISTS bluepoint;

-- Definir search_path para usar o schema bluepoint
SET search_path TO bluepoint;

-- =====================================================
-- TIPOS ENUMERADOS
-- =====================================================

CREATE TYPE bluepoint.tipo_usuario AS ENUM ('colaborador', 'gestor', 'gerente', 'supervisor', 'coordenador', 'admin');
CREATE TYPE bluepoint.status_registro AS ENUM ('ativo', 'inativo');
CREATE TYPE bluepoint.tipo_marcacao AS ENUM ('entrada', 'saida', 'almoco', 'retorno');
CREATE TYPE bluepoint.metodo_marcacao AS ENUM ('app', 'web', 'biometria');
CREATE TYPE bluepoint.tipo_movimentacao_horas AS ENUM ('credito', 'debito', 'compensacao', 'ajuste');
CREATE TYPE bluepoint.status_solicitacao AS ENUM ('pendente', 'aprovada', 'rejeitada', 'cancelada');
CREATE TYPE bluepoint.tipo_solicitacao AS ENUM ('ajuste_ponto', 'ferias', 'atestado', 'ausencia', 'outros');
CREATE TYPE bluepoint.tipo_anexo AS ENUM ('atestado', 'comprovante', 'documento', 'foto', 'outros');
CREATE TYPE bluepoint.tipo_localizacao AS ENUM ('matriz', 'filial', 'obra', 'cliente', 'outros');
CREATE TYPE bluepoint.tipo_feriado AS ENUM ('nacional', 'estadual', 'municipal', 'empresa');
CREATE TYPE bluepoint.tipo_notificacao AS ENUM ('sistema', 'solicitacao', 'marcacao', 'alerta', 'lembrete');

-- =====================================================
-- TABELAS PRINCIPAIS
-- =====================================================

-- Tabela de Departamentos
CREATE TABLE bluepoint.bt_departamentos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    gestor_id INTEGER,
    status bluepoint.status_registro DEFAULT 'ativo',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_departamentos_status ON bluepoint.bt_departamentos(status);
CREATE INDEX idx_bt_departamentos_gestor ON bluepoint.bt_departamentos(gestor_id);

-- Tabela de Jornadas de Trabalho
CREATE TABLE bluepoint.bt_jornadas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    carga_horaria_semanal DECIMAL(5,2) DEFAULT 44.00,
    tolerancia_entrada INTEGER DEFAULT 10, -- minutos
    tolerancia_saida INTEGER DEFAULT 10, -- minutos
    status bluepoint.status_registro DEFAULT 'ativo',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_jornadas_status ON bluepoint.bt_jornadas(status);

-- Tabela de Horários da Jornada (dias da semana)
CREATE TABLE bluepoint.bt_jornada_horarios (
    id SERIAL PRIMARY KEY,
    jornada_id INTEGER NOT NULL REFERENCES bluepoint.bt_jornadas(id) ON DELETE CASCADE,
    dia_semana SMALLINT CHECK (dia_semana BETWEEN 0 AND 6), -- 0=domingo, 6=sábado (para jornada simples)
    sequencia SMALLINT, -- ordem no ciclo (para jornada circular): 1, 2, 3...
    quantidade_dias SMALLINT DEFAULT 1, -- quantos dias esse bloco dura (para circular)
    dias_semana JSONB DEFAULT '[]', -- [1, 2, 3, 4, 5] = seg a sex (para circular)
    folga BOOLEAN DEFAULT FALSE,
    periodos JSONB DEFAULT '[]', -- [{"entrada": "08:00", "saida": "12:00"}, {"entrada": "13:00", "saida": "18:00"}]
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_jornada_horarios_jornada ON bluepoint.bt_jornada_horarios(jornada_id);

-- Tabela de Colaboradores
CREATE TABLE bluepoint.bt_colaboradores (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    senha_hash VARCHAR(255) NOT NULL,
    cpf VARCHAR(14) NOT NULL UNIQUE,
    rg VARCHAR(20),
    telefone VARCHAR(20),
    cargo_id INTEGER,
    tipo bluepoint.tipo_usuario DEFAULT 'colaborador',
    departamento_id INTEGER REFERENCES bluepoint.bt_departamentos(id) ON DELETE SET NULL,
    jornada_id INTEGER REFERENCES bluepoint.bt_jornadas(id) ON DELETE SET NULL,
    data_admissao DATE NOT NULL,
    data_nascimento DATE,
    status bluepoint.status_registro DEFAULT 'ativo',
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

CREATE INDEX idx_bt_colaboradores_email ON bluepoint.bt_colaboradores(email);
CREATE INDEX idx_bt_colaboradores_cpf ON bluepoint.bt_colaboradores(cpf);
CREATE INDEX idx_bt_colaboradores_departamento ON bluepoint.bt_colaboradores(departamento_id);
CREATE INDEX idx_bt_colaboradores_jornada ON bluepoint.bt_colaboradores(jornada_id);
CREATE INDEX idx_bt_colaboradores_cargo ON bluepoint.bt_colaboradores(cargo_id);
CREATE INDEX idx_bt_colaboradores_status ON bluepoint.bt_colaboradores(status);
CREATE INDEX idx_bt_colaboradores_tipo ON bluepoint.bt_colaboradores(tipo);

-- Adicionar FK do gestor no departamento após criar colaboradores
ALTER TABLE bluepoint.bt_departamentos 
ADD CONSTRAINT fk_departamento_gestor 
FOREIGN KEY (gestor_id) REFERENCES bluepoint.bt_colaboradores(id) ON DELETE SET NULL;

-- Adicionar FK do cargo no colaborador (bt_cargos deve existir antes)
ALTER TABLE bluepoint.bt_colaboradores
ADD CONSTRAINT fk_colaborador_cargo
FOREIGN KEY (cargo_id) REFERENCES bluepoint.bt_cargos(id) ON DELETE SET NULL;

-- Tabela de Documentos do Colaborador
CREATE TABLE bluepoint.bt_documentos_colaborador (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    tipo VARCHAR(50) NOT NULL,
    nome VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    tamanho INTEGER,
    data_upload TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_documentos_colaborador ON bluepoint.bt_documentos_colaborador(colaborador_id);

-- Tabela de Marcações de Ponto
CREATE TABLE bluepoint.bt_marcacoes (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    data_hora TIMESTAMP NOT NULL,
    tipo bluepoint.tipo_marcacao NOT NULL,
    latitude DECIMAL(10,8),
    longitude DECIMAL(11,8),
    endereco TEXT,
    metodo bluepoint.metodo_marcacao DEFAULT 'web',
    foto_url TEXT,
    observacao TEXT,
    justificativa TEXT,
    criado_por INTEGER REFERENCES bluepoint.bt_colaboradores(id), -- para marcações manuais
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_marcacoes_colaborador ON bluepoint.bt_marcacoes(colaborador_id);
CREATE INDEX idx_bt_marcacoes_data_hora ON bluepoint.bt_marcacoes(data_hora);
CREATE INDEX idx_bt_marcacoes_tipo ON bluepoint.bt_marcacoes(tipo);
CREATE INDEX idx_bt_marcacoes_data ON bluepoint.bt_marcacoes((data_hora::date));

-- Tabela de Banco de Horas
CREATE TABLE bluepoint.bt_banco_horas (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    tipo bluepoint.tipo_movimentacao_horas NOT NULL,
    descricao TEXT,
    horas DECIMAL(5,2) NOT NULL, -- positivo=crédito, negativo=débito
    saldo_anterior DECIMAL(6,2) NOT NULL DEFAULT 0,
    saldo_atual DECIMAL(6,2) NOT NULL DEFAULT 0,
    observacao TEXT,
    criado_por INTEGER REFERENCES bluepoint.bt_colaboradores(id),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_banco_horas_colaborador ON bluepoint.bt_banco_horas(colaborador_id);
CREATE INDEX idx_bt_banco_horas_data ON bluepoint.bt_banco_horas(data);
CREATE INDEX idx_bt_banco_horas_tipo ON bluepoint.bt_banco_horas(tipo);

-- Tabela de Solicitações
CREATE TABLE bluepoint.bt_solicitacoes (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    tipo bluepoint.tipo_solicitacao NOT NULL,
    status bluepoint.status_solicitacao DEFAULT 'pendente',
    data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_evento DATE,
    data_evento_fim DATE, -- para períodos (férias, atestados)
    descricao TEXT,
    justificativa TEXT,
    dados_adicionais JSONB, -- dados específicos por tipo
    gestor_id INTEGER REFERENCES bluepoint.bt_colaboradores(id), -- gestor responsável (usado em hora_extra)
    aprovador_id INTEGER REFERENCES bluepoint.bt_colaboradores(id),
    data_aprovacao TIMESTAMP,
    motivo_rejeicao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_solicitacoes_colaborador ON bluepoint.bt_solicitacoes(colaborador_id);
CREATE INDEX idx_bt_solicitacoes_tipo ON bluepoint.bt_solicitacoes(tipo);
CREATE INDEX idx_bt_solicitacoes_status ON bluepoint.bt_solicitacoes(status);
CREATE INDEX idx_bt_solicitacoes_data ON bluepoint.bt_solicitacoes(data_solicitacao);
CREATE INDEX idx_bt_solicitacoes_aprovador ON bluepoint.bt_solicitacoes(aprovador_id);
CREATE INDEX idx_bt_solicitacoes_gestor ON bluepoint.bt_solicitacoes(gestor_id);

-- Tabela de Histórico de Status das Solicitações
CREATE TABLE bluepoint.bt_solicitacoes_historico (
    id SERIAL PRIMARY KEY,
    solicitacao_id INTEGER NOT NULL REFERENCES bluepoint.bt_solicitacoes(id) ON DELETE CASCADE,
    status_anterior bluepoint.status_solicitacao,
    status_novo bluepoint.status_solicitacao NOT NULL,
    usuario_id INTEGER REFERENCES bluepoint.bt_colaboradores(id),
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_solicitacoes_historico_solicitacao ON bluepoint.bt_solicitacoes_historico(solicitacao_id);

-- Tabela de Anexos
CREATE TABLE bluepoint.bt_anexos (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    solicitacao_id INTEGER REFERENCES bluepoint.bt_solicitacoes(id) ON DELETE CASCADE,
    tipo bluepoint.tipo_anexo DEFAULT 'documento',
    nome VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    tamanho INTEGER,
    descricao TEXT,
    data_upload TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_anexos_colaborador ON bluepoint.bt_anexos(colaborador_id);
CREATE INDEX idx_bt_anexos_solicitacao ON bluepoint.bt_anexos(solicitacao_id);

-- Tabela de Localizações (Geofence)
CREATE TABLE bluepoint.bt_localizacoes (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    tipo bluepoint.tipo_localizacao DEFAULT 'matriz',
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
    status bluepoint.status_registro DEFAULT 'ativo',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_localizacoes_status ON bluepoint.bt_localizacoes(status);
CREATE INDEX idx_bt_localizacoes_tipo ON bluepoint.bt_localizacoes(tipo);

-- Tabela de Feriados
CREATE TABLE bluepoint.bt_feriados (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    data DATE NOT NULL,
    tipo bluepoint.tipo_feriado DEFAULT 'nacional',
    recorrente BOOLEAN DEFAULT FALSE,
    abrangencia VARCHAR(100), -- ex: "SP", "São Paulo", etc.
    descricao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_feriados_data ON bluepoint.bt_feriados(data);
CREATE INDEX idx_bt_feriados_tipo ON bluepoint.bt_feriados(tipo);
CREATE INDEX idx_bt_feriados_recorrente ON bluepoint.bt_feriados(recorrente);

-- Tabela de Notificações
CREATE TABLE bluepoint.bt_notificacoes (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    tipo bluepoint.tipo_notificacao DEFAULT 'sistema',
    titulo VARCHAR(255) NOT NULL,
    mensagem TEXT NOT NULL,
    lida BOOLEAN DEFAULT FALSE,
    data_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_leitura TIMESTAMP,
    link TEXT,
    metadados JSONB
);

CREATE INDEX idx_bt_notificacoes_usuario ON bluepoint.bt_notificacoes(usuario_id);
CREATE INDEX idx_bt_notificacoes_lida ON bluepoint.bt_notificacoes(lida);
CREATE INDEX idx_bt_notificacoes_data ON bluepoint.bt_notificacoes(data_envio);

-- Tabela de Refresh Tokens
CREATE TABLE bluepoint.bt_refresh_tokens (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    token VARCHAR(500) NOT NULL UNIQUE,
    data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_expiracao TIMESTAMP NOT NULL,
    revogado BOOLEAN DEFAULT FALSE,
    revogado_em TIMESTAMP
);

CREATE INDEX idx_bt_refresh_tokens_usuario ON bluepoint.bt_refresh_tokens(usuario_id);
CREATE INDEX idx_bt_refresh_tokens_token ON bluepoint.bt_refresh_tokens(token);

-- Tabela de Tokens de Recuperação de Senha
CREATE TABLE bluepoint.bt_tokens_recuperacao (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_expiracao TIMESTAMP NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    usado_em TIMESTAMP
);

CREATE INDEX idx_bt_tokens_recuperacao_token ON bluepoint.bt_tokens_recuperacao(token);
CREATE INDEX idx_bt_tokens_recuperacao_usuario ON bluepoint.bt_tokens_recuperacao(usuario_id);

-- Tabela de Configurações da Empresa
CREATE TABLE bluepoint.bt_configuracoes_empresa (
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
CREATE TABLE bluepoint.bt_configuracoes (
    id SERIAL PRIMARY KEY,
    categoria VARCHAR(50) NOT NULL,
    chave VARCHAR(100) NOT NULL,
    valor TEXT,
    descricao TEXT,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(categoria, chave)
);

CREATE INDEX idx_bt_configuracoes_categoria ON bluepoint.bt_configuracoes(categoria);

-- Tabela de Biometria Facial
CREATE TABLE bluepoint.bt_biometria_facial (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    encoding BYTEA, -- dados do encoding facial
    qualidade DECIMAL(3,2), -- 0.00 a 1.00
    foto_referencia_url TEXT,
    data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_bt_biometria_facial_colaborador ON bluepoint.bt_biometria_facial(colaborador_id);

-- Tabela de Logs de Auditoria
CREATE TABLE bluepoint.bt_auditoria (
    id SERIAL PRIMARY KEY,
    data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    usuario_id INTEGER REFERENCES bluepoint.bt_colaboradores(id) ON DELETE SET NULL,
    acao VARCHAR(50) NOT NULL, -- CREATE, UPDATE, DELETE, LOGIN, LOGOUT, etc.
    modulo VARCHAR(50) NOT NULL, -- colaboradores, marcacoes, solicitacoes, etc.
    descricao TEXT,
    ip VARCHAR(45),
    user_agent TEXT,
    dados_anteriores JSONB,
    dados_novos JSONB,
    metadados JSONB
);

CREATE INDEX idx_bt_auditoria_data ON bluepoint.bt_auditoria(data_hora);
CREATE INDEX idx_bt_auditoria_usuario ON bluepoint.bt_auditoria(usuario_id);
CREATE INDEX idx_bt_auditoria_acao ON bluepoint.bt_auditoria(acao);
CREATE INDEX idx_bt_auditoria_modulo ON bluepoint.bt_auditoria(modulo);

-- Tabela de Histórico de Jornadas do Colaborador (para manter histórico de mudanças)
CREATE TABLE bluepoint.bt_colaborador_jornadas_historico (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    jornada_id INTEGER NOT NULL REFERENCES bluepoint.bt_jornadas(id) ON DELETE CASCADE,
    data_inicio DATE NOT NULL,
    data_fim DATE,
    criado_por INTEGER REFERENCES bluepoint.bt_colaboradores(id),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_colaborador_jornadas_colaborador ON bluepoint.bt_colaborador_jornadas_historico(colaborador_id);
CREATE INDEX idx_bt_colaborador_jornadas_jornada ON bluepoint.bt_colaborador_jornadas_historico(jornada_id);

-- Tabela de Tipos de Solicitação (configurável)
CREATE TABLE bluepoint.bt_tipos_solicitacao (
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
CREATE TABLE bluepoint.bt_localizacao_departamentos (
    id SERIAL PRIMARY KEY,
    localizacao_id INTEGER NOT NULL REFERENCES bluepoint.bt_localizacoes(id) ON DELETE CASCADE,
    departamento_id INTEGER NOT NULL REFERENCES bluepoint.bt_departamentos(id) ON DELETE CASCADE,
    UNIQUE(localizacao_id, departamento_id)
);

-- =====================================================
-- FUNÇÕES E TRIGGERS
-- =====================================================

-- Função para atualizar timestamp de atualização
CREATE OR REPLACE FUNCTION bluepoint.atualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para atualização automática de timestamp
CREATE TRIGGER tr_colaboradores_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_colaboradores
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_departamentos_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_departamentos
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_jornadas_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_jornadas
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_marcacoes_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_marcacoes
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_solicitacoes_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_solicitacoes
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_localizacoes_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_localizacoes
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_feriados_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_feriados
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_configuracoes_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_configuracoes
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_configuracoes_empresa_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_configuracoes_empresa
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

CREATE TRIGGER tr_biometria_facial_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_biometria_facial
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

-- =====================================================
-- DADOS INICIAIS
-- =====================================================

-- Configurações padrão do sistema
INSERT INTO bluepoint.bt_configuracoes (categoria, chave, valor, descricao) VALUES
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
INSERT INTO bluepoint.bt_tipos_solicitacao (codigo, nome, descricao, requer_anexo, campos_adicionais) VALUES
    ('ajuste_ponto', 'Ajuste de Ponto', 'Solicitação de ajuste em marcação de ponto', false, '{"marcacaoId": "number", "dataHoraCorreta": "datetime", "motivo": "string"}'),
    ('ferias', 'Férias', 'Solicitação de período de férias', false, '{"dataInicio": "date", "dataFim": "date", "dias": "number"}'),
    ('atestado', 'Atestado Médico', 'Envio de atestado médico', true, '{"cid": "string", "dataInicio": "date", "dataFim": "date"}'),
    ('ausencia', 'Justificativa de Ausência', 'Justificativa para ausência/falta', false, '{"data": "date", "motivo": "string"}'),
    ('outros', 'Outros', 'Outras solicitações', false, null);

-- Feriados nacionais (2026)
INSERT INTO bluepoint.bt_feriados (nome, data, tipo, recorrente, abrangencia) VALUES
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
INSERT INTO bluepoint.bt_configuracoes_empresa (id) VALUES (1);

-- =====================================================
-- VIEWS ÚTEIS
-- =====================================================

-- View de colaboradores com departamento, cargo e jornada
CREATE OR REPLACE VIEW bluepoint.vw_colaboradores_completo AS
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
FROM bluepoint.bt_colaboradores c
LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
LEFT JOIN bluepoint.bt_jornadas j ON c.jornada_id = j.id;

-- View de marcações do dia atual
CREATE OR REPLACE VIEW bluepoint.vw_marcacoes_hoje AS
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
FROM bluepoint.bt_marcacoes m
JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id
LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
WHERE DATE(m.data_hora) = CURRENT_DATE
ORDER BY m.data_hora DESC;

-- View de solicitações pendentes
CREATE OR REPLACE VIEW bluepoint.vw_solicitacoes_pendentes AS
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
FROM bluepoint.bt_solicitacoes s
JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id
LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
WHERE s.status = 'pendente'
ORDER BY s.data_solicitacao ASC;

-- View de saldo de banco de horas por colaborador
CREATE OR REPLACE VIEW bluepoint.vw_saldo_banco_horas AS
SELECT 
    c.id as colaborador_id,
    c.nome as colaborador_nome,
    COALESCE(
        (SELECT saldo_atual 
         FROM bluepoint.bt_banco_horas 
         WHERE colaborador_id = c.id 
         ORDER BY criado_em DESC 
         LIMIT 1), 
        0
    ) as saldo_atual,
    (SELECT MAX(criado_em) 
     FROM bluepoint.bt_banco_horas 
     WHERE colaborador_id = c.id) as ultima_atualizacao
FROM bluepoint.bt_colaboradores c
WHERE c.status = 'ativo';

-- =====================================================
-- COMENTÁRIOS NAS TABELAS
-- =====================================================

COMMENT ON TABLE bluepoint.bt_colaboradores IS 'Tabela de colaboradores/usuários do sistema';
COMMENT ON TABLE bluepoint.bt_departamentos IS 'Departamentos da empresa';
COMMENT ON TABLE bluepoint.bt_jornadas IS 'Jornadas de trabalho definidas';
COMMENT ON TABLE bluepoint.bt_jornada_horarios IS 'Horários de cada dia da semana para uma jornada';
COMMENT ON TABLE bluepoint.bt_marcacoes IS 'Marcações de ponto dos colaboradores';
COMMENT ON TABLE bluepoint.bt_banco_horas IS 'Movimentações do banco de horas';
COMMENT ON TABLE bluepoint.bt_solicitacoes IS 'Solicitações diversas (ajustes, férias, atestados)';
COMMENT ON TABLE bluepoint.bt_anexos IS 'Arquivos anexados a solicitações';
COMMENT ON TABLE bluepoint.bt_localizacoes IS 'Localizações permitidas para registro de ponto (geofence)';
COMMENT ON TABLE bluepoint.bt_feriados IS 'Feriados cadastrados no sistema';
COMMENT ON TABLE bluepoint.bt_notificacoes IS 'Notificações enviadas aos usuários';
COMMENT ON TABLE bluepoint.bt_refresh_tokens IS 'Tokens de refresh para autenticação JWT';
COMMENT ON TABLE bluepoint.bt_tokens_recuperacao IS 'Tokens para recuperação de senha';
COMMENT ON TABLE bluepoint.bt_configuracoes IS 'Configurações gerais do sistema';
COMMENT ON TABLE bluepoint.bt_configuracoes_empresa IS 'Dados cadastrais da empresa';
COMMENT ON TABLE bluepoint.bt_biometria_facial IS 'Dados de biometria facial dos colaboradores';
COMMENT ON TABLE bluepoint.bt_auditoria IS 'Logs de auditoria do sistema';

-- =====================================================
-- TABELA DE PARÂMETROS DE HORA EXTRA
-- =====================================================

-- Parâmetros globais de tolerância de hora extra
CREATE TABLE bluepoint.bt_parametros_hora_extra (
    id SERIAL PRIMARY KEY,
    minutos_tolerancia INTEGER NOT NULL DEFAULT 10,
    dias_permitidos_por_mes INTEGER NOT NULL DEFAULT 2,
    ativo BOOLEAN DEFAULT TRUE,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por INTEGER REFERENCES bluepoint.bt_colaboradores(id) ON DELETE SET NULL
);

COMMENT ON TABLE bluepoint.bt_parametros_hora_extra IS 'Parâmetros globais de tolerância de hora extra';

CREATE TRIGGER tr_parametros_hora_extra_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_parametros_hora_extra
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

-- Histórico de tolerância de hora extra por colaborador
CREATE TABLE bluepoint.bt_historico_tolerancia_hora_extra (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    minutos_hora_extra INTEGER NOT NULL,
    consumiu_tolerancia BOOLEAN DEFAULT TRUE,
    parametro_id INTEGER REFERENCES bluepoint.bt_parametros_hora_extra(id) ON DELETE SET NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(colaborador_id, data)
);

CREATE INDEX idx_bt_hist_tol_he_colaborador ON bluepoint.bt_historico_tolerancia_hora_extra(colaborador_id);
CREATE INDEX idx_bt_hist_tol_he_data ON bluepoint.bt_historico_tolerancia_hora_extra(data);
CREATE INDEX idx_bt_hist_tol_he_colab_data ON bluepoint.bt_historico_tolerancia_hora_extra(colaborador_id, data);

COMMENT ON TABLE bluepoint.bt_historico_tolerancia_hora_extra IS 'Histórico de dias em que a tolerância de hora extra foi consumida';

-- Adicionar coluna de origem nas solicitações
ALTER TABLE bluepoint.bt_solicitacoes ADD COLUMN IF NOT EXISTS origem VARCHAR(20) DEFAULT 'manual';
CREATE INDEX idx_bt_solicitacoes_origem ON bluepoint.bt_solicitacoes(origem);

-- =====================================================
-- TABELA DE CONFIGURAÇÕES DO SISTEMA POR EMPRESA
-- =====================================================

CREATE TABLE bluepoint.bt_config_sistema (
    id SERIAL PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES bluepoint.bt_empresas(id) ON DELETE CASCADE,
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
    atualizado_por INTEGER REFERENCES bluepoint.bt_colaboradores(id) ON DELETE SET NULL,
    UNIQUE(empresa_id)
);

CREATE INDEX idx_bt_config_sistema_empresa ON bluepoint.bt_config_sistema(empresa_id);

COMMENT ON TABLE bluepoint.bt_config_sistema IS 'Configurações do sistema por empresa (geral, ponto, notificações, segurança, aparência)';

CREATE TRIGGER tr_config_sistema_atualizado_em
    BEFORE UPDATE ON bluepoint.bt_config_sistema
    FOR EACH ROW EXECUTE FUNCTION bluepoint.atualizar_timestamp();

-- =====================================================
-- FIM DO SCRIPT
-- =====================================================
