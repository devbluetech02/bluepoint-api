CREATE TABLE IF NOT EXISTS bluepoint.bt_parametros_esportes (
    id SERIAL PRIMARY KEY,
    dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
    hora_inicio TIME NOT NULL,
    total_jogadores INTEGER NOT NULL CHECK (total_jogadores > 0),
    horas_jogo INTEGER NOT NULL CHECK (horas_jogo > 0),
    local VARCHAR(255) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_por INTEGER REFERENCES bluepoint.bt_colaboradores(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bluepoint.bt_esportes_sessoes (
    id SERIAL PRIMARY KEY,
    data_sessao DATE NOT NULL UNIQUE,
    hora_inicio TIME NOT NULL,
    horas_jogo INTEGER NOT NULL CHECK (horas_jogo > 0),
    local VARCHAR(255) NOT NULL,
    total_vagas INTEGER NOT NULL CHECK (total_vagas > 0),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bluepoint.bt_esportes_inscricoes (
    id SERIAL PRIMARY KEY,
    sessao_id INTEGER NOT NULL REFERENCES bluepoint.bt_esportes_sessoes(id) ON DELETE CASCADE,
    colaborador_id INTEGER NOT NULL REFERENCES bluepoint.bt_colaboradores(id) ON DELETE CASCADE,
    posicao VARCHAR(20) NOT NULL CHECK (posicao IN ('linha', 'goleiro')),
    confirmado BOOLEAN NOT NULL DEFAULT false,
    confirmado_em TIMESTAMP,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sessao_id, colaborador_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_esportes_sessoes_data ON bluepoint.bt_esportes_sessoes(data_sessao);
CREATE INDEX IF NOT EXISTS idx_bt_esportes_inscricoes_sessao ON bluepoint.bt_esportes_inscricoes(sessao_id);
CREATE INDEX IF NOT EXISTS idx_bt_esportes_inscricoes_colaborador ON bluepoint.bt_esportes_inscricoes(colaborador_id);
