CREATE TABLE bluepoint.bt_modelos_exportacao (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE bluepoint.bt_codigos_exportacao (
  id SERIAL PRIMARY KEY,
  modelo_id INTEGER NOT NULL REFERENCES bluepoint.bt_modelos_exportacao(id) ON DELETE CASCADE,
  codigo VARCHAR(10) NOT NULL,
  descricao TEXT,
  status_arquivo VARCHAR(20) NOT NULL DEFAULT 'valido',
  status_econtador VARCHAR(20) NOT NULL DEFAULT 'valido',
  criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_codigos_exportacao_modelo_id ON bluepoint.bt_codigos_exportacao(modelo_id);
CREATE INDEX idx_modelos_exportacao_ativo ON bluepoint.bt_modelos_exportacao(ativo);
