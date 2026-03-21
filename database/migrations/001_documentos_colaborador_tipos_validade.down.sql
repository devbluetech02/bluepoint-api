-- Remover índice e colunas adicionadas em bt_documentos_colaborador
DROP INDEX IF EXISTS bluepoint.idx_bt_documentos_colaborador_validade;
DROP INDEX IF EXISTS bluepoint.idx_bt_documentos_colaborador_tipo;

ALTER TABLE bluepoint.bt_documentos_colaborador
  DROP COLUMN IF EXISTS data_validade,
  DROP COLUMN IF EXISTS storage_key,
  DROP COLUMN IF EXISTS tipo_documento_id;

-- Remover tabela de vínculo cargo x tipo documento
DROP TABLE IF EXISTS bluepoint.bt_cargo_tipo_documento;

-- Remover tabela de tipos de documento
DROP TABLE IF EXISTS bluepoint.bt_tipos_documento_colaborador;
