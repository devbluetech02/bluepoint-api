-- ============================================================
-- MIGRAÇÃO: Módulo Gestão de Pessoas
-- ============================================================

BEGIN;

-- Tabela principal de registros
CREATE TABLE IF NOT EXISTS bluepoint.bt_gestao_pessoas (
  id SERIAL PRIMARY KEY,
  colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id),
  tipo VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pendente',
  titulo VARCHAR(255) NOT NULL,
  descricao TEXT NOT NULL,
  responsavel_id INTEGER NOT NULL,
  data_registro DATE NOT NULL DEFAULT CURRENT_DATE,
  data_conclusao DATE,
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT chk_gp_tipo CHECK (tipo IN ('advertencia', 'demissao', 'feedback_positivo', 'feedback_negativo')),
  CONSTRAINT chk_gp_status CHECK (status IN ('pendente', 'em_andamento', 'concluido', 'cancelado'))
);

-- Tabela de reuniões (1:1 com gestao_pessoas)
CREATE TABLE IF NOT EXISTS bluepoint.bt_gestao_pessoas_reunioes (
  id SERIAL PRIMARY KEY,
  gestao_pessoa_id INTEGER NOT NULL UNIQUE REFERENCES bluepoint.bt_gestao_pessoas(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  hora VARCHAR(5) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'agendada',
  observacoes TEXT,
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT chk_reuniao_status CHECK (status IN ('agendada', 'realizada', 'cancelada'))
);

-- Participantes da reunião
CREATE TABLE IF NOT EXISTS bluepoint.bt_gestao_pessoas_participantes (
  id SERIAL PRIMARY KEY,
  reuniao_id INTEGER NOT NULL REFERENCES bluepoint.bt_gestao_pessoas_reunioes(id) ON DELETE CASCADE,
  colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id),
  UNIQUE (reuniao_id, colaborador_id)
);

-- Anexos dos registros
CREATE TABLE IF NOT EXISTS bluepoint.bt_gestao_pessoas_anexos (
  id SERIAL PRIMARY KEY,
  gestao_pessoa_id INTEGER NOT NULL REFERENCES bluepoint.bt_gestao_pessoas(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  tamanho BIGINT NOT NULL,
  url TEXT NOT NULL,
  caminho_storage TEXT NOT NULL,
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_gp_colaborador ON bluepoint.bt_gestao_pessoas(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_gp_tipo ON bluepoint.bt_gestao_pessoas(tipo);
CREATE INDEX IF NOT EXISTS idx_gp_status ON bluepoint.bt_gestao_pessoas(status);
CREATE INDEX IF NOT EXISTS idx_gp_data_registro ON bluepoint.bt_gestao_pessoas(data_registro DESC);
CREATE INDEX IF NOT EXISTS idx_gp_responsavel ON bluepoint.bt_gestao_pessoas(responsavel_id);
CREATE INDEX IF NOT EXISTS idx_gp_anexos_registro ON bluepoint.bt_gestao_pessoas_anexos(gestao_pessoa_id);
CREATE INDEX IF NOT EXISTS idx_gp_participantes_reuniao ON bluepoint.bt_gestao_pessoas_participantes(reuniao_id);

COMMIT;
