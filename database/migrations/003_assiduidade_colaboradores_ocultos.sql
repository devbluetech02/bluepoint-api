-- Colaboradores ocultos na visão de assiduidade (lista/dashboard), sem bloquear ponto.
CREATE TABLE IF NOT EXISTS people.assiduidade_colaboradores_ocultos (
    colaborador_id INTEGER NOT NULL PRIMARY KEY
        REFERENCES people.colaboradores(id) ON DELETE CASCADE,
    criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assiduidade_ocultos_colaborador
    ON people.assiduidade_colaboradores_ocultos (colaborador_id);

COMMENT ON TABLE people.assiduidade_colaboradores_ocultos IS
    'Colaboradores ocultados apenas na interface de assiduidade; não altera bloqueio de ponto.';
