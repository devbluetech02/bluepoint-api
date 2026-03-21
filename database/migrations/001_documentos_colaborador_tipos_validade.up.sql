-- Requer: bluepoint.bt_cargos existente (FK em bt_cargo_tipo_documento).
-- Tipos de documento do colaborador (ASO, EPI, CNH, etc.)
-- validade_meses: NULL = sem validade; número = renovar a cada X meses
-- obrigatorio_padrao: true = exigido para todos os cargos; false = opcional
-- A tabela bt_cargo_tipo_documento pode tornar um tipo opcional para cargos específicos (ex.: vendedor interno sem CNH)
CREATE TABLE IF NOT EXISTS bluepoint.bt_tipos_documento_colaborador (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nome_exibicao VARCHAR(100) NOT NULL,
    validade_meses INTEGER,
    obrigatorio_padrao BOOLEAN NOT NULL DEFAULT true,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bt_tipos_documento_codigo ON bluepoint.bt_tipos_documento_colaborador(codigo);

-- Obrigatoriedade por cargo: se (cargo_id, tipo_documento_id) existe, usa obrigatorio; senão usa obrigatorio_padrao do tipo
CREATE TABLE IF NOT EXISTS bluepoint.bt_cargo_tipo_documento (
    cargo_id INTEGER NOT NULL REFERENCES bluepoint.bt_cargos(id) ON DELETE CASCADE,
    tipo_documento_id INTEGER NOT NULL REFERENCES bluepoint.bt_tipos_documento_colaborador(id) ON DELETE CASCADE,
    obrigatorio BOOLEAN NOT NULL,
    PRIMARY KEY (cargo_id, tipo_documento_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_cargo_tipo_documento_cargo ON bluepoint.bt_cargo_tipo_documento(cargo_id);
CREATE INDEX IF NOT EXISTS idx_bt_cargo_tipo_documento_tipo ON bluepoint.bt_cargo_tipo_documento(tipo_documento_id);

-- Colunas novas em bt_documentos_colaborador
ALTER TABLE bluepoint.bt_documentos_colaborador
  ADD COLUMN IF NOT EXISTS tipo_documento_id INTEGER REFERENCES bluepoint.bt_tipos_documento_colaborador(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS storage_key TEXT,
  ADD COLUMN IF NOT EXISTS data_validade DATE;

CREATE INDEX IF NOT EXISTS idx_bt_documentos_colaborador_tipo ON bluepoint.bt_documentos_colaborador(tipo_documento_id);
CREATE INDEX IF NOT EXISTS idx_bt_documentos_colaborador_validade ON bluepoint.bt_documentos_colaborador(data_validade);

-- Seed dos 6 tipos de documento
INSERT INTO bluepoint.bt_tipos_documento_colaborador (codigo, nome_exibicao, validade_meses, obrigatorio_padrao)
VALUES
  ('aso', 'ASO', 12, true),
  ('epi', 'EPI', 12, true),
  ('direcao_defensiva', 'Direção Defensiva', 12, true),
  ('cnh', 'CNH', 60, true),
  ('nr35', 'NR35', 12, true),
  ('outros', 'Outros Documentos', NULL, false)
ON CONFLICT (codigo) DO NOTHING;
